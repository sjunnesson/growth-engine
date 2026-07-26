/**
 * Product onboarding wizard — CLI front-end over lib/setup.ts. The dashboard
 * Setup page (app/setup) is the friendlier way to do this; the CLI remains
 * for headless/agent-driven onboarding.
 *
 *   npm run setup -- --repo <path> [--vault <path>] [--out <dir>]
 *                    [--answers <file>] [--status-file <file>]
 *
 * Everything it writes is a DRAFT: product.json ships reviewed=false, which
 * forces every channel to dry-run until a human signs off in the dashboard.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";
import {
  type Answers,
  defaultAnswers,
  finalizeAnswers,
  gatherRepoEvidence,
  kebab,
  runOnboarding,
} from "@/lib/setup";
import { env } from "@/lib/env";

interface Args {
  repo: string;
  vault?: string;
  out: string;
  answersFile?: string;
  statusFile?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = get("--repo");
  if (!repo) {
    console.error(
      "Usage: npm run setup -- --repo <path> [--vault <path>] [--out <dir>] [--answers <file>] [--status-file <file>]",
    );
    process.exit(1);
  }
  return {
    repo: resolve(repo),
    vault: get("--vault") ? resolve(get("--vault")!) : undefined,
    out: resolve(get("--out") ?? "product"),
    answersFile: get("--answers"),
    statusFile: get("--status-file"),
  };
}

async function interview(repoEvidence: string): Promise<Answers> {
  const inferredName =
    repoEvidence.match(/"name":\s*"([^"@/]+)"/)?.[1] ??
    repoEvidence.match(/^--- README[^\n]*---\n#\s+([^\n]+)/m)?.[1] ??
    "";
  const defaults = defaultAnswers();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def: string) => {
    const answer = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return answer || def;
  };
  const askList = async (q: string, def: string[]) =>
    (await ask(q + " (comma-separated)", def.join(",")))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  console.log("\n== Interview — facts the analysis cannot infer ==\n");
  const a = { ...defaults };
  a.name = await ask("Product name", inferredName);
  a.slug = kebab(await ask("Slug (kebab-case id)", kebab(a.name)));
  a.domain = await ask("Canonical domain (e.g. example.com)", "");
  a.siteUrl = await ask("Site URL", a.domain ? `https://${a.domain}` : "");
  a.websiteRepo = await ask("Website GitHub repo the engine commits content into (owner/repo)", "");
  a.websiteBranch = await ask("Website branch", "main");
  a.releasesRepo = await ask("GitHub repo whose Releases feed the changelog (owner/repo)", a.websiteRepo);
  a.format = (await ask("Content file format: json | markdown", "markdown")) as Answers["format"];
  a.tagScheme = (await ask("Release tag scheme: semver | any", "semver")) as Answers["tagScheme"];
  a.socialTargets = await askList("Social channels to target (mastodon,bluesky,linkedin,reddit,x)", defaults.socialTargets);
  a.ctaRelease = await ask("CTA path for release posts (site-relative)", "/");
  a.ctaSeo = await ask("CTA path for SEO pages", a.ctaRelease);
  a.ctaComparison = await ask("CTA path for comparison pages", "/");
  a.priceTokens = await askList("EXACT allowed price tokens, e.g. $0,$19 (empty = no prices may ever appear)", []);
  a.pricingNotes = await ask("Pricing model in one or two sentences (tiers, limits, one-time vs subscription; 'none' if unpriced)", "");
  a.competitors = await askList("Competitor/category names generated copy must never characterize", []);
  a.neverClaim = await ask("Anything the copy must NEVER claim (free-form)", "");
  rl.close();
  return finalizeAnswers(a);
}

async function main() {
  const args = parseArgs();
  if (!existsSync(args.repo) || !statSync(args.repo).isDirectory())
    throw new Error(`--repo is not a directory: ${args.repo}`);
  if (args.vault && (!existsSync(args.vault) || !statSync(args.vault).isDirectory()))
    throw new Error(`--vault is not a directory: ${args.vault}`);

  const answers = args.answersFile
    ? finalizeAnswers(JSON.parse(readFileSync(args.answersFile, "utf-8")) as Partial<Answers>)
    : await interview(gatherRepoEvidence(args.repo));

  const r = await runOnboarding({
    repo: args.repo,
    vault: args.vault,
    out: args.out,
    answers,
    statusFile: args.statusFile ?? null,
  });

  console.log(`
[setup] DRAFT product written to ${r.out}
        facts.md: ${r.todos} TODO(verify) marker(s) to resolve
        angles: ${r.angles} · seo pages: ${r.seoPages} · comparisons: ${r.comparisons}

Next steps (the engine stays dry-run-only until step 4):
  1. Read + fix ${r.out}/factbase/facts.md — resolve every TODO, delete
     anything not literally true. Review banned-claims.json and product.json.
  2. Create this instance's env: cp .env.example .env.local (own DATABASE_URL,
     own PORT), then: npm run db:migrate
  3. Verify the pipeline end-to-end without publishing: npm run dryrun
  4. Open the dashboard (npm run dev) → Overview → "I reviewed the fact base"
     — only then do DRY_RUN / LIVE_CHANNELS start to matter.

Or do 1-4 in the guided UI: npm run dev → http://127.0.0.1:${process.env.PORT || 3400}/setup
(generation model: ${env.genModel})
`);
}

main().catch((e) => {
  console.error(`[setup] FATAL: ${(e as Error).message}`);
  process.exit(1);
});
