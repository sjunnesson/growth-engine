/**
 * End-to-end dry-run smoke. `npm run dryrun`.
 *
 * 1. Deterministic guardrail self-test (no network) — proves lint() blocks
 *    invented price / banned phrase / wrong link.
 * 2. If ANTHROPIC_API_KEY + DATABASE_URL present: enqueue a content + social
 *    batch and drain the queue through the real pipeline in DRY_RUN mode
 *    (generates + guards, writes would-be payloads to audit_log, no external
 *    publish, no commits).
 *
 * Exits non-zero if the guardrail self-test fails — that invariant must hold.
 */
import { lint } from "@/lib/guardrails/lint";
import { loadBanned } from "@/lib/sources/factbase";
import { isConfigured, product } from "@/lib/product";

if (!isConfigured()) {
  console.error(
    "[dryrun] no product configured — onboard one first (dashboard /setup, or npm run setup).",
  );
  process.exit(1);
}

/** A price token the product does NOT allow, in the product's own currency
 *  symbol — proves the allowlist actually gates. */
function inventedPrice(allowed: string[]): string {
  const symbol = allowed[0]?.match(/^[$€£]/)?.[0] ?? "$";
  for (const amount of [49, 137, 421, 9999]) {
    const tok = `${symbol}${amount}`;
    if (!allowed.includes(tok)) return tok;
  }
  return `${symbol}123456789`;
}

/** Fixtures derive from the LIVE factbase (banned-claims.json + base
 *  templates + product.json) — the self-test proves THIS product's guardrail
 *  config gates, not a hard-coded example's. */
function selfTestGuardrails(): boolean {
  const banned = loadBanned();
  const cfg = product();
  const url = `${cfg.siteUrl.replace(/\/$/, "")}/?utm_source=mastodon`;
  const name = cfg.name;

  const cases: { name: string; text: string; mustBlock: boolean; skip?: string }[] = [
    {
      name: "clean",
      text: `${name} keeps your work on your machine. Try it: ${url}`,
      mustBlock: false,
    },
    {
      name: "invented price",
      text: `${name} Pro is just ${inventedPrice(banned.allowedPriceTokens)} one-time. ${url}`,
      mustBlock: true,
    },
    {
      name: "hype phrase",
      text: `You won't believe what ${name} can do. ${url}`,
      mustBlock: true,
      skip: banned.bannedPhrases.some((p) =>
        new RegExp(p, "i").test("you won't believe"),
      )
        ? undefined
        : "no matching banned pattern configured",
    },
    {
      name: "extra/foreign link",
      text: `Check ${name} and also https://not-our-domain.example ${url}`,
      mustBlock: true,
      skip: banned.requireSingleCanonicalLink
        ? undefined
        : "requireSingleCanonicalLink=false",
    },
    {
      name: "no link",
      text: `${name} keeps your work on your machine, private and yours.`,
      mustBlock: true,
      skip: banned.requireSingleCanonicalLink
        ? undefined
        : "requireSingleCanonicalLink=false",
    },
    {
      name: "emoji overflow",
      text: `${name} update ${"🎉".repeat(banned.maxEmoji + 1)} ${url}`,
      mustBlock: true,
    },
  ];

  let ok = true;
  for (const c of cases) {
    if (c.skip) {
      console.log(`  [skip] ${c.name} — ${c.skip}`);
      continue;
    }
    const r = lint(c.text, { channel: "mastodon", expectedUrl: url });
    const blocked = !r.ok;
    const pass = blocked === c.mustBlock;
    console.log(
      `  [${pass ? "PASS" : "FAIL"}] ${c.name} — blocked=${blocked} (${r.violations.join("; ") || "none"})`,
    );
    if (!pass) ok = false;
  }
  return ok;
}

async function pipelineDryRun() {
  const { ensureLocalDb } = await import("@/lib/localdb");
  await ensureLocalDb();
  if (!process.env.DATABASE_URL) {
    console.log(
      "\n[skip] DATABASE_URL not set — skipping live pipeline dry-run.",
    );
    return;
  }
  console.log(
    "\n[note] generation uses the `claude` CLI — it must be installed +\n" +
      "       authenticated here, or rows will end 'failed' (visible in audit_log).",
  );
  if (process.env.DRY_RUN === "false") {
    console.log("\n[abort] DRY_RUN=false — refusing to run a 'dry-run' that could publish.");
    return;
  }
  const { enqueueContentBatch, enqueueEvergreenSocial } = await import(
    "@/lib/enqueuers"
  );
  const { claimDue } = await import("@/lib/dedupe");
  const { processRow } = await import("@/lib/pipeline");
  const { sql } = await import("@/lib/db/client");

  console.log("\n[pipeline] enqueueing content + social batch ...");
  const a = await enqueueContentBatch("dryrun");
  const b = await enqueueEvergreenSocial("dryrun");
  console.log(`[pipeline] enqueued ${a + b} new items`);

  let processed = 0;
  for (let i = 0; i < 30; i++) {
    const rows = await claimDue(5);
    if (rows.length === 0) break;
    for (const row of rows) {
      const outcome = await processRow("dryrun", row);
      console.log(`  ${row.channel}/${row.source_kind} -> ${outcome}`);
      processed++;
    }
  }

  const summary = await sql<{ status: string; n: number }[]>`
    SELECT status, count(*)::int AS n FROM post_queue GROUP BY status ORDER BY status`;
  console.log(`\n[pipeline] processed ${processed}; queue:`, summary);
  await sql.end();
}

(async () => {
  console.log("== guardrail self-test (deterministic, no network) ==");
  const guardOk = selfTestGuardrails();
  await pipelineDryRun();
  if (!guardOk) {
    console.error("\nGUARDRAIL SELF-TEST FAILED — do not deploy.");
    process.exit(1);
  }
  console.log("\nguardrail self-test OK.");
})();
