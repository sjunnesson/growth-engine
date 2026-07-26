import { assertCron, json } from "@/lib/http";
import { abortIfKilled, blockedBy, scopeFor } from "@/lib/killswitch";
import { claimDue, requeue, claimApproved, deferApproved } from "@/lib/dedupe";
import { processRow, publishApprovedRow } from "@/lib/pipeline";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ACTOR = "cron:dispatch";
const BATCH = 8;


export async function GET(req: Request) {
  const unauth = assertCron(req);
  if (unauth) return unauth;
  // Global gate first (env GROWTH_HALT or kill_switch 'global').
  if (await abortIfKilled(ACTOR, "global")) return json({ aborted: "killswitch:global" });

  const rows = await claimDue(BATCH);
  const results: Record<string, number> = {};

  for (const row of rows) {
    // Granular gate: skip (and release) rows whose scope is halted.
    const by = await blockedBy(scopeFor(row.channel));
    if (by) {
      await requeue(row.id, new Date(Date.now() + 30 * 60 * 1000));
      await audit(ACTOR, "killswitch_abort", { channel: row.channel, blockedBy: by }, { queueId: row.id, level: "warn" });
      results["killswitch_abort"] = (results["killswitch_abort"] ?? 0) + 1;
      continue;
    }

    let outcome = "error";
    try {
      outcome = await processRow(ACTOR, row);
    } catch (err) {
      await requeue(row.id, new Date(Date.now() + 15 * 60 * 1000));
      await audit(ACTOR, "error", { unhandled: (err as Error).message }, { queueId: row.id, level: "error" });
    }
    results[outcome] = (results[outcome] ?? 0) + 1;
  }

  // Publish dashboard-approved items.
  const approved = await claimApproved(BATCH);
  for (const row of approved) {
    const by = await blockedBy(scopeFor(row.channel));
    if (by) {
      await deferApproved(row.id, new Date(Date.now() + 30 * 60 * 1000));
      await audit(ACTOR, "killswitch_abort", { channel: row.channel, blockedBy: by, lane: "approved" }, { queueId: row.id, level: "warn" });
      results["killswitch_abort"] = (results["killswitch_abort"] ?? 0) + 1;
      continue;
    }
    let outcome = "error";
    try {
      outcome = await publishApprovedRow(ACTOR, row);
    } catch (err) {
      await deferApproved(row.id, new Date(Date.now() + 15 * 60 * 1000));
      await audit(ACTOR, "error", { unhandled: (err as Error).message, lane: "approved" }, { queueId: row.id, level: "error" });
    }
    results[`approved:${outcome}`] = (results[`approved:${outcome}`] ?? 0) + 1;
  }

  return json({
    ok: true,
    claimed: rows.length,
    approvedPublished: approved.length,
    results,
  });
}
