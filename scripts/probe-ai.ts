/**
 * Smoke-test the Claude Code CLI AI provider on THIS host. `npm run probe`.
 *
 * No DB, no publishing: runs one real `claude -p` generation for an evergreen
 * Mastodon post, then the deterministic lint over it. Use this on any host
 * before trusting it to run the AI crons (confirms `claude` is installed +
 * authenticated and the guardrail accepts real output).
 */
import { generate } from "@/lib/claude/generate";
import { lint } from "@/lib/guardrails/lint";
import { loadEvergreen } from "@/lib/sources/factbase";
import { utmUrl } from "@/lib/social/utm";
import { isConfigured } from "@/lib/product";

(async () => {
  if (!isConfigured()) {
    console.error(
      "[probe] no product configured — onboard one first (dashboard /setup, or npm run setup).",
    );
    process.exit(1);
  }
  const angle = loadEvergreen()[0];
  const dedupeKey = `probe:${angle.id}:mastodon`;
  const url = utmUrl(
    new URL(angle.cta).pathname || "/",
    "mastodon",
    "evergreen",
    dedupeKey,
  );

  console.log(`[probe] generating an evergreen Mastodon post via 'claude -p' ...`);
  console.log(`[probe] angle: ${angle.id}\n`);

  const r = await generate({
    channel: "mastodon",
    sourceKind: "evergreen",
    url,
    brief: angle.brief,
  });

  console.log("─".repeat(60));
  console.log(r.text);
  console.log("─".repeat(60));

  const lr = lint(r.text, { channel: "mastodon", expectedUrl: url });
  console.log(
    `\n[probe] lint: ${lr.ok ? "PASS" : "BLOCK"}${
      lr.ok ? "" : " — " + lr.violations.join("; ")
    }`,
  );
  console.log(
    `[probe] model=${r.meta.model} in=${r.meta.inputTokens} out=${r.meta.outputTokens} cost=$${r.meta.costUsd}`,
  );
  console.log("\n[probe] OK — the claude-cli provider works on this host.");
})().catch((e) => {
  console.error("\n[probe] FAILED:", e.message);
  console.error(
    "If this is 'claude not found' or an auth error, this host cannot run the AI crons (see SETUP.md §1.3/1.4).",
  );
  process.exit(1);
});
