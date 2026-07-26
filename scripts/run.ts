/**
 * Headless one-shot runner — the engine "tick". `npm run once`.
 *
 * This replaces the Vercel cron + HTTP routes when running on a host that has
 * the `claude` CLI (e.g. this Mac via launchd). One invocation:
 *   1. global kill-switch check
 *   2. run ALL enqueuers (idempotent — dedupe keys make re-runs no-ops, so a
 *      frequent tick is safe; weekly/slug/release dedupe bounds volume)
 *   3. drain the due queue through the full pipeline (guardrails + dry-run +
 *      rate limits all still apply), then exit
 *
 * Schedule it with launchd (see deploy/) — rate limits + weekly dedupe keep
 * output correct regardless of how often the tick fires.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { env } from "@/lib/env";
import { isConfigured, product } from "@/lib/product";
import { ensureLocalDb } from "@/lib/localdb";
import { abortIfKilled, blockedBy, scopeFor } from "@/lib/killswitch";
import {
  enqueueReleases,
  enqueueContentBatch,
  enqueueEvergreenSocial,
} from "@/lib/enqueuers";
import {
  claimDue,
  requeue,
  claimApproved,
  deferApproved,
  requeueAttempt,
  reapStuck,
  setStatus,
} from "@/lib/dedupe";
import { processRow, publishApprovedRow } from "@/lib/pipeline";
import { audit } from "@/lib/audit";
import { pruneRateLimit } from "@/lib/ratelimit";
import { sql } from "@/lib/db/client";

const ACTOR = "runner:local";
const BATCH = 8;
const MAX_BATCHES = 20; // bound a single tick's runtime
const MAX_ATTEMPTS = 5; // unhandled-error retries before a row fails for good
const STUCK_AFTER_MINUTES = 60;

async function main() {
  // Fresh checkout: no product yet. Idle politely (status for the menu bar
  // app) instead of crash-looping every tick until setup is done.
  if (!isConfigured()) {
    console.log("[run] no product configured — open the dashboard Setup page.");
    writeStatus({ ok: true, configured: false, tally: {}, ready: 0, queue: {} });
    return;
  }
  await ensureLocalDb(); // managed .pgdata database: start it if stopped
  // Product drafted but infrastructure unfinished: also idle, and tell the
  // menu bar app it's a setup gap, not an engine failure.
  if (!process.env.DATABASE_URL) {
    console.log("[run] DATABASE_URL not set — finish setup in the dashboard.");
    writeStatus({
      ok: true,
      setupIncomplete: "no database yet",
      tally: {},
      ready: 0,
      queue: {},
    });
    return;
  }

  if (await abortIfKilled(ACTOR, "global")) {
    console.log("[run] halted by kill switch (global/GROWTH_HALT). Nothing done.");
    await sql.end();
    return;
  }

  // 1b. Reclaim rows a killed tick left mid-flight; prune dead rate windows.
  const reaped = await reapStuck(STUCK_AFTER_MINUTES);
  for (const r of reaped) {
    await audit(ACTOR, "reaped", { channel: r.channel, backTo: r.status }, { queueId: r.id, level: "warn" });
  }
  if (reaped.length) console.log(`[run] reaped ${reaped.length} stuck row(s)`);
  await pruneRateLimit();

  // 2. Enqueue (idempotent). Releases needs GITHUB_TOKEN; if absent, keep
  // going so content/social evergreen still flow.
  let enq = 0;
  try {
    enq += await enqueueReleases(ACTOR);
  } catch (e) {
    console.warn(`[run] enqueueReleases skipped: ${(e as Error).message}`);
  }
  enq += await enqueueContentBatch(ACTOR);
  enq += await enqueueEvergreenSocial(ACTOR);
  console.log(`[run] enqueued ${enq} new item(s)`);

  // 3. Drain.
  const tally: Record<string, number> = {};
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await claimDue(BATCH);
    if (rows.length === 0) break;
    for (const row of rows) {
      const by = await blockedBy(scopeFor(row.channel));
      if (by) {
        await requeue(row.id, new Date(Date.now() + 30 * 60 * 1000));
        await audit(ACTOR, "killswitch_abort", { channel: row.channel, blockedBy: by }, { queueId: row.id, level: "warn" });
        tally["killswitch_abort"] = (tally["killswitch_abort"] ?? 0) + 1;
        continue;
      }
      let outcome = "error";
      try {
        outcome = await processRow(ACTOR, row);
      } catch (err) {
        outcome = await handleUnhandled(row.id, row.attempts, err as Error, "auto");
      }
      console.log(`  ${row.channel}/${row.source_kind} -> ${outcome}`);
      tally[outcome] = (tally[outcome] ?? 0) + 1;
    }
  }

  // 4. Publish items a human approved in the dashboard.
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await claimApproved(BATCH);
    if (rows.length === 0) break;
    for (const row of rows) {
      const by = await blockedBy(scopeFor(row.channel));
      if (by) {
        await deferApproved(row.id, new Date(Date.now() + 30 * 60 * 1000));
        await audit(ACTOR, "killswitch_abort", { channel: row.channel, blockedBy: by, lane: "approved" }, { queueId: row.id, level: "warn" });
        tally["killswitch_abort"] = (tally["killswitch_abort"] ?? 0) + 1;
        continue;
      }
      let outcome = "error";
      try {
        outcome = await publishApprovedRow(ACTOR, row);
      } catch (err) {
        outcome = await handleUnhandled(row.id, row.attempts, err as Error, "approved");
      }
      console.log(`  [approved] ${row.channel}/${row.source_kind} -> ${outcome}`);
      tally[`approved:${outcome}`] = (tally[`approved:${outcome}`] ?? 0) + 1;
    }
  }

  // 5. Surface pending approvals — the dashboard is pull-based, so nudge.
  const [readyRow] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM post_queue WHERE status = 'ready'`;
  if (readyRow?.n) {
    console.log(`[run] ${readyRow.n} item(s) awaiting approval — npm run dashboard`);
    await notifyMac(`${readyRow.n} post(s) awaiting approval`);
  }

  // 6. Status artifact for the menu bar app (and anything else).
  const counts = await sql<{ status: string; n: number }[]>`
    SELECT status, count(*)::int AS n FROM post_queue GROUP BY status`;
  writeStatus({
    ok: true,
    tally,
    ready: readyRow?.n ?? 0,
    queue: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  });

  console.log(`[run] tick done:`, tally);
  await sql.end();
}

/** Written after every tick (and on fatal failure) to .status.json in the
 *  repo root; the menu bar app polls it. Never throws. */
function writeStatus(s: Record<string, unknown>): void {
  try {
    writeFileSync(
      ".status.json",
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          posture: { dryRun: env.dryRun, liveChannels: [...env.liveChannels] },
          ...s,
        },
        null,
        2,
      ) + "\n",
    );
  } catch {
    /* status file is best-effort */
  }
}

/** Unhandled error: retry with backoff, give up for good past MAX_ATTEMPTS. */
async function handleUnhandled(
  id: string,
  priorAttempts: number,
  err: Error,
  lane: "auto" | "approved",
): Promise<string> {
  if (priorAttempts + 1 >= MAX_ATTEMPTS) {
    await setStatus(id, "failed", {
      last_error: `gave up after ${MAX_ATTEMPTS} attempts: ${err.message}`,
    });
    await audit(ACTOR, "error", { unhandled: err.message, gaveUp: true, lane }, { queueId: id, level: "error" });
    return "failed:gave_up";
  }
  await requeueAttempt(id, new Date(Date.now() + 15 * 60 * 1000), err.message, lane);
  await audit(ACTOR, "error", { unhandled: err.message, lane }, { queueId: id, level: "error" });
  return "error:requeued";
}

/** macOS notification; must never fail (or outlive) the tick. */
function notifyMac(message: string): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  // osascript string literal: strip characters that would break (or escape
  // out of) the quoted AppleScript string.
  const safe = message.replace(/[\\"]/g, "'").slice(0, 120);
  let title = "Marketing Engine";
  try {
    title = `${product().name} Marketing Engine`.replace(/[\\"]/g, "'");
  } catch {
    /* notification must work even if product.json is broken */
  }
  return new Promise((done) => {
    execFile(
      "osascript",
      ["-e", `display notification "${safe}" with title "${title}"`],
      () => done(),
    );
  });
}

main().catch(async (e) => {
  // postgres.js connection failures throw with an empty .message — the
  // detail lives in .code / .errors[]. Fall back until something is legible.
  const err = e as Error & { code?: string; errors?: Error[] };
  const msg =
    err?.message || err?.code || err?.errors?.[0]?.message || String(e);
  console.error("[run] FATAL:", msg);
  writeStatus({ ok: false, error: msg });
  // A silently failing scheduled tick (DB down after a reboot, revoked
  // token) would stall the whole engine — surface it on the desktop.
  await notifyMac(`tick FAILED: ${msg}`);
  try {
    await sql.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
