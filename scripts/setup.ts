/**
 * Product onboarding wizard. `npm run setup -- --repo <path> [--vault <path>]`
 *
 * Points the engine at a new product: analyzes the product's code repo (and,
 * optionally, an Obsidian vault of notes) with the Claude Code CLI, interviews
 * the operator for the facts an analysis cannot infer (pricing, domains,
 * channels), then drafts the complete product directory:
 *
 *   product.json                     identity, repos, site layout, channels
 *   factbase/facts.md                the closed world (DRAFT — must be reviewed)
 *   factbase/banned-claims.json      product-specific guardrail patterns
 *   factbase/social-evergreen.json   drip angles
 *   factbase/seo-pages.json          landing-page briefs
 *   factbase/comparisons.json        comparison-page briefs
 *
 * Everything it writes is a DRAFT: product.json ships with reviewed=false,
 * which forces every channel to dry-run (pipeline.effectiveLive) until a
 * human signs off in the dashboard. The generation prompts are closed-world
 * (assert only what the evidence supports; mark gaps TODO(verify)) but the
 * REAL guarantee is that review step — never weaken it.
 *
 * Flags:
 *   --repo <path>      product source repo to analyze (required)
 *   --vault <path>     Obsidian vault (or any markdown folder) to mine
 *   --out <dir>        output product dir (default ./product; must not exist)
 *   --answers <file>   JSON of interview answers → non-interactive run
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { runClaude } from "@/lib/claude/cli";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// args

interface Args {
  repo: string;
  vault?: string;
  out: string;
  answersFile?: string;
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
      "Usage: npm run setup -- --repo <path> [--vault <path>] [--out <dir>] [--answers <file>]",
    );
    process.exit(1);
  }
  return {
    repo: resolve(repo),
    vault: get("--vault") ? resolve(get("--vault")!) : undefined,
    out: resolve(get("--out") ?? "product"),
    answersFile: get("--answers"),
  };
}

// ---------------------------------------------------------------------------
// evidence

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n[...truncated]" : s);

function tryRead(path: string, capBytes: number): string | null {
  try {
    return cap(readFileSync(path, "utf-8"), capBytes);
  } catch {
    return null;
  }
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "composer.json",
  "Package.swift",
  "Gemfile",
];

/** Does this directory look like a product source repo (vs. a workspace
 *  folder holding several)? README, a build manifest, an Xcode project, or
 *  git history all count. */
function looksLikeRepo(dir: string): boolean {
  try {
    const entries = readdirSync(dir);
    return (
      entries.some((f) => /^readme(\.|$)/i.test(f)) ||
      MANIFESTS.some((m) => entries.includes(m)) ||
      entries.some((f) => f.endsWith(".xcodeproj")) ||
      entries.includes(".git")
    );
  } catch {
    return false;
  }
}

/** Bounded, deterministic sweep of the product repo: README, manifests,
 *  top-level docs, release tags. No LLM here — this just assembles evidence. */
function gatherRepoEvidence(repo: string): string {
  const parts: string[] = [];
  const push = (label: string, text: string | null) => {
    if (text?.trim()) parts.push(`--- ${label} ---\n${text.trim()}`);
  };

  // Baseline the model can always orient on, even in a sparse repo.
  const top = readdirSync(repo).filter((f) => !f.startsWith("."));
  push("top-level entries", top.slice(0, 60).join("\n"));

  for (const f of top) {
    if (/^readme(\.|$)/i.test(f)) push(f, tryRead(join(repo, f), 16_000));
    if (f.endsWith(".xcodeproj")) push("xcode project", f);
  }
  for (const f of MANIFESTS) {
    push(f, tryRead(join(repo, f), 2_000));
  }
  const docs = readdirSync(repo).filter(
    (f) => f.endsWith(".md") && !/^readme/i.test(f),
  );
  for (const f of docs.slice(0, 5)) push(f, tryRead(join(repo, f), 6_000));
  const docsDir = join(repo, "docs");
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir).filter((f) => f.endsWith(".md")).slice(0, 5))
      push(`docs/${f}`, tryRead(join(docsDir, f), 6_000));
  }
  push("recent git tags", git(repo, ["tag", "--sort=-creatordate"]).split("\n").slice(0, 15).join("\n"));
  push("recent commits", git(repo, ["log", "--oneline", "-15"]));
  return cap(parts.join("\n\n"), 48_000);
}

/** All markdown notes in the vault (paths + first heading), skipping Obsidian
 *  internals. The triage call picks which ones to actually read. */
function listVaultNotes(vault: string): { path: string; title: string }[] {
  const out: { path: string; title: string }[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 500) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        const head = tryRead(p, 400) ?? "";
        const title = head.match(/^#\s+(.+)$/m)?.[1] ?? basename(e.name, ".md");
        out.push({ path: p.slice(vault.length + 1), title });
      }
    }
  };
  walk(vault);
  return out;
}

function parseJsonReply(text: string): unknown {
  const stripped = text.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const starts = ["{", "["].map((c) => stripped.indexOf(c)).filter((i) => i >= 0);
    const end = Math.max(stripped.lastIndexOf("}"), stripped.lastIndexOf("]"));
    if (starts.length === 0 || end < 0)
      throw new Error(`no JSON found in reply (head: ${JSON.stringify(text.slice(0, 120))})`);
    return JSON.parse(stripped.slice(Math.min(...starts), end + 1));
  }
}

/** JSON drafting call with retries — models occasionally wrap the JSON in
 *  prose or truncate; a retry with a reinforcement line almost always fixes
 *  it, and one flaky reply must not kill a whole (paid) wizard run. */
async function draftJson<T>(
  label: string,
  system: string,
  user: string,
  model: string,
): Promise<T> {
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sys =
      attempt === 1
        ? system
        : `${system}\n\nREMINDER: your ENTIRE reply must be the JSON value itself. No prose, no markdown fences, no explanation.`;
    const r = await runClaude(sys, user, model);
    try {
      return parseJsonReply(r.text) as T;
    } catch (e) {
      lastErr = (e as Error).message;
      console.warn(`[setup] ${label}: attempt ${attempt}/3 reply was not valid JSON (${lastErr}) — retrying`);
    }
  }
  throw new Error(`${label}: no valid JSON after 3 attempts (${lastErr})`);
}

/** Ask Claude (critic model — triage is cheap) which notes matter, then read
 *  those. */
async function gatherVaultEvidence(vault: string): Promise<string> {
  const notes = listVaultNotes(vault);
  if (notes.length === 0) return "";
  console.log(`[setup] vault: ${notes.length} notes found — triaging relevance ...`);

  let chosen: string[];
  try {
    const r = await runClaude(
      `You triage a personal note vault for a marketing-engine setup. From the list, pick up to 15 notes most likely to contain PRODUCT knowledge: positioning, audience, feature descriptions, pricing thoughts, roadmap, brand voice, things the maker decided NOT to claim. Ignore journals, unrelated projects, clippings. Reply with ONLY a JSON array of path strings from the list.`,
      notes.map((n) => `${n.path} — ${n.title}`).join("\n"),
      env.criticModel,
    );
    chosen = (parseJsonReply(r.text) as string[]).filter(
      (p) => typeof p === "string" && notes.some((n) => n.path === p),
    );
  } catch (e) {
    console.warn(`[setup] vault triage failed (${(e as Error).message}) — reading first 10 notes instead`);
    chosen = notes.slice(0, 10).map((n) => n.path);
  }

  const parts: string[] = [];
  let total = 0;
  for (const p of chosen) {
    const text = tryRead(join(vault, p), 8_000);
    if (!text) continue;
    total += text.length;
    if (total > 64_000) break;
    parts.push(`--- vault: ${p} ---\n${text.trim()}`);
  }
  console.log(`[setup] vault: reading ${parts.length} notes`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// interview

interface Answers {
  name: string;
  slug: string;
  domain: string;
  siteUrl: string;
  releasesRepo: string;
  websiteRepo: string;
  websiteBranch: string;
  format: "json" | "markdown";
  tagScheme: "semver" | "any";
  socialTargets: string[];
  ctaRelease: string;
  ctaSeo: string;
  ctaComparison: string;
  priceTokens: string[];
  pricingNotes: string;
  competitors: string[];
  neverClaim: string;
}

const kebab = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Accept owner/repo in any common spelling: bare, full https URL, git URL,
 *  trailing .git. The engine needs the bare "owner/repo" form. */
function normalizeRepo(input: string): string {
  const s = input
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com[/:]/i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (s && !/^[\w.-]+\/[\w.-]+$/.test(s))
    throw new Error(`"${input}" is not a GitHub repo — expected owner/repo (or a github.com URL)`);
  return s;
}

async function interview(repoEvidence: string, answersFile?: string): Promise<Answers> {
  const inferredName =
    repoEvidence.match(/"name":\s*"([^"@/]+)"/)?.[1] ??
    repoEvidence.match(/^--- README[^\n]*---\n#\s+([^\n]+)/m)?.[1] ??
    "";

  const defaults: Answers = {
    name: inferredName,
    slug: kebab(inferredName),
    domain: "",
    siteUrl: "",
    releasesRepo: "",
    websiteRepo: "",
    websiteBranch: "main",
    format: "markdown",
    tagScheme: "semver",
    socialTargets: ["mastodon", "bluesky"],
    ctaRelease: "/",
    ctaSeo: "/",
    ctaComparison: "/",
    priceTokens: [],
    pricingNotes: "",
    competitors: [],
    neverClaim: "",
  };

  if (answersFile) {
    const given = JSON.parse(readFileSync(answersFile, "utf-8")) as Partial<Answers>;
    const a = { ...defaults, ...given };
    for (const k of ["name", "domain", "websiteRepo"] as const) {
      if (!a[k]) throw new Error(`--answers file missing required field: ${k}`);
    }
    a.slug = a.slug || kebab(a.name);
    a.siteUrl = a.siteUrl || `https://${a.domain}`;
    a.websiteRepo = normalizeRepo(a.websiteRepo);
    a.releasesRepo = normalizeRepo(a.releasesRepo) || a.websiteRepo;
    return a;
  }

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
  a.name = await ask("Product name", defaults.name);
  a.slug = kebab(await ask("Slug (kebab-case id)", kebab(a.name)));
  a.domain = await ask("Canonical domain (e.g. example.com)", "");
  a.siteUrl = await ask("Site URL", a.domain ? `https://${a.domain}` : "");
  a.websiteRepo = normalizeRepo(
    await ask("Website GitHub repo the engine commits content into (owner/repo)", ""),
  );
  a.websiteBranch = await ask("Website branch", "main");
  a.releasesRepo = normalizeRepo(
    await ask("GitHub repo whose Releases feed the changelog (owner/repo)", a.websiteRepo),
  );
  a.format = (await ask("Content file format: json | markdown", "markdown")) === "json" ? "json" : "markdown";
  a.tagScheme = (await ask("Release tag scheme: semver | any", "semver")) === "any" ? "any" : "semver";
  a.socialTargets = await askList("Social channels to target (mastodon,bluesky,linkedin,reddit,x)", defaults.socialTargets);
  a.ctaRelease = await ask("CTA path for release posts (site-relative)", "/");
  a.ctaSeo = await ask("CTA path for SEO pages", a.ctaRelease);
  a.ctaComparison = await ask("CTA path for comparison pages", "/");
  a.priceTokens = await askList("EXACT allowed price tokens, e.g. $0,$19 (empty = no prices may ever appear)", []);
  a.pricingNotes = await ask("Pricing model in one or two sentences (tiers, limits, one-time vs subscription; 'none' if unpriced)", "");
  a.competitors = await askList("Competitor/category names generated copy must never characterize", []);
  a.neverClaim = await ask("Anything the copy must NEVER claim (free-form)", "");
  rl.close();

  if (!a.name || !a.domain || !a.websiteRepo)
    throw new Error("name, domain, and website repo are required");
  return a;
}

// ---------------------------------------------------------------------------
// generation

const evidenceBlock = (repo: string, vault: string, a: Answers) => `
<repo-evidence>
${repo || "(none)"}
</repo-evidence>

<vault-evidence>
${vault || "(none)"}
</vault-evidence>

<operator-interview>
Product: ${a.name} (${a.slug}) — ${a.siteUrl} (domain ${a.domain})
Pricing (ground truth, EXACT): ${a.pricingNotes || "not stated"}; allowed price tokens: ${a.priceTokens.join(", ") || "NONE (no prices may appear in copy)"}
Never claim: ${a.neverClaim || "(nothing beyond the standard rules)"}
Competitors never to characterize: ${a.competitors.join(", ") || "(none named)"}
</operator-interview>`;

async function draftFacts(repoEv: string, vaultEv: string, a: Answers): Promise<string> {
  const system = `You draft the FACT BASE for an autonomous marketing engine. The fact base is a CLOSED WORLD: generated marketing copy may later assert ONLY what this file states, so a wrong line here becomes a published lie. Rules:
- Assert only what the evidence (repo, vault, interview) supports. The interview is operator-supplied ground truth and outranks inference.
- Be conservative and literal. No superlatives, no adjectives doing factual work, no guesses about metrics, dates, or platforms.
- Where a section needs a fact the evidence does not supply, write a single line: "TODO(verify): <what the operator must fill in>". Prefer a TODO over a plausible guess, always.
- Never use em dashes.
Output ONLY the markdown body, starting with "# ${a.name} — Fact Base", with exactly these sections:
## One-liner
## What it is
## How it works
## Features (approved, literally true)
## Privacy${a.pricingNotes && a.pricingNotes !== "none" ? "\n## Pricing (EXACT — never alter these numbers)" : ""}
## Where to get it
Do NOT write voice/style or never-say sections; they are appended from a template.`;
  const r = await runClaude(system, evidenceBlock(repoEv, vaultEv, a), env.genModel);
  return r.text.trim();
}

interface GuardrailDraft {
  bannedPhrases: string[];
  criticNotes: string[];
}

async function draftGuardrails(repoEv: string, vaultEv: string, a: Answers): Promise<GuardrailDraft> {
  const system = `You write PRODUCT-SPECIFIC guardrail patterns for a marketing-copy linter. Generic hype/AI-slop patterns already exist; produce only what is specific to THIS product:
- Regexes (case-insensitive JS regex source strings) that catch claims this product's pricing model forbids (e.g. calling a capped free tier "unlimited" or "free forever").
- Regexes catching characterizations of the named competitors ("better than X", "X is slow/bad/expensive").
- Regexes for anything in the operator's never-claim list.
Also produce 1-4 short "criticNotes": product-specific sentences for an LLM reviewer (e.g. "Implying the Free tier is unlimited is a violation (capped at N)").
Keep patterns precise — they BLOCK copy on match, so an over-broad regex silences legitimate copy. Reply with ONLY compact JSON: {"bannedPhrases": string[], "criticNotes": string[]}.`;
  const j = await draftJson<Partial<GuardrailDraft>>(
    "guardrails",
    system,
    evidenceBlock(repoEv, vaultEv, a),
    env.genModel,
  );
  const phrases = (j.bannedPhrases ?? []).filter((p) => {
    try {
      new RegExp(String(p), "i");
      return true;
    } catch {
      console.warn(`[setup] dropping invalid regex from draft: ${p}`);
      return false;
    }
  });
  return {
    bannedPhrases: phrases.map(String),
    criticNotes: (j.criticNotes ?? []).map(String).slice(0, 4),
  };
}

interface ContentDraft {
  angles: { id: string; brief: string; cta: string }[];
  seoPages: { slug: string; audience: string; intent: string; primaryFeature: string }[];
  comparisons: { slug: string; category: string; angle: string }[];
}

async function draftContentPlan(repoEv: string, vaultEv: string, a: Answers): Promise<ContentDraft> {
  const system = `You plan the evergreen content for an autonomous marketing engine. Everything must be COVERED BY THE EVIDENCE — an angle about a feature the evidence doesn't show will generate copy that lies. Produce:
- "angles": 8-10 evergreen social/blog angles. Each: {"id": kebab-case slug, "brief": 20-400 chars describing what the copy should say (a brief, not copy; no em dashes), "cta": full URL on ${a.siteUrl}}.
- "seoPages": 4-6 landing-page briefs. Each: {"slug": kebab-case, "audience": who it's for, "intent": the search intent it answers, "primaryFeature": the evidenced feature it leans on}.
- "comparisons": 0-3 category comparisons (vs a CATEGORY like "web clippers", never a named competitor). Each: {"slug": kebab-case, "category": the category, "angle": what makes this product's approach different, factually}.
Reply with ONLY compact JSON: {"angles": [...], "seoPages": [...], "comparisons": [...]}.`;
  const j = await draftJson<Partial<ContentDraft>>(
    "content plan",
    system,
    evidenceBlock(repoEv, vaultEv, a),
    env.genModel,
  );

  const okSlug = (s: unknown) => typeof s === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
  const okCta = (c: unknown) => {
    try {
      const host = new URL(String(c)).host;
      return host === a.domain || host.endsWith("." + a.domain);
    } catch {
      return false;
    }
  };
  return {
    angles: (j.angles ?? []).filter(
      (x) => okSlug(x?.id) && typeof x?.brief === "string" && x.brief.length >= 20 && x.brief.length <= 400 && okCta(x?.cta),
    ),
    seoPages: (j.seoPages ?? []).filter((x) => okSlug(x?.slug)),
    comparisons: (j.comparisons ?? []).filter((x) => okSlug(x?.slug)),
  };
}

// ---------------------------------------------------------------------------
// output

function writeProductDir(
  out: string,
  a: Answers,
  facts: string,
  guard: GuardrailDraft,
  plan: ContentDraft,
) {
  const fb = join(out, "factbase");
  mkdirSync(fb, { recursive: true });
  const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

  const productJson = {
    _comment:
      "Generated by npm run setup — a DRAFT until reviewed=true (flip it in the dashboard after checking factbase/). Env vars GITHUB_RELEASES_REPO / GITHUB_WEBSITE_REPO / GITHUB_WEBSITE_BRANCH / SITE_URL override their fields here.",
    name: a.name,
    slug: a.slug,
    domain: a.domain,
    siteUrl: a.siteUrl,
    github: {
      releasesRepo: a.releasesRepo,
      websiteRepo: a.websiteRepo,
      websiteBranch: a.websiteBranch,
    },
    cta: { release: a.ctaRelease, seo: a.ctaSeo, comparison: a.ctaComparison },
    site: {
      format: a.format,
      contentDirs: {
        changelog: "content/changelog",
        blog: "content/blog",
        seo: "content/seo",
        comparison: "content/seo",
      },
      urlPaths: { changelog: "/changelog", blog: "/blog", seo: "/use", comparison: "/use" },
    },
    releases: { tagScheme: a.tagScheme, socialMaxAgeDays: 14, rollupPatchCount: 3 },
    socialTargets: a.socialTargets,
    criticNotes: guard.criticNotes,
    reviewed: false,
  };
  writeFileSync(join(out, "product.json"), j(productJson));

  const style = readFileSync(resolve("templates", "facts-style.md"), "utf-8")
    .replaceAll("{{NAME}}", a.name)
    .replaceAll("{{DOMAIN}}", a.domain);
  const version = `${new Date().toISOString().slice(0, 10)}.1`;
  const header = `<!--
FACTBASE_VERSION: ${version}
STATUS: DRAFT — generated by setup, NOT yet reviewed. Fix every TODO(verify),
delete anything not literally true, then mark reviewed in the dashboard.
This file is the CLOSED WORLD. Generated marketing copy may assert facts ONLY
from this file (plus verbatim release notes passed at generation time).
Bump FACTBASE_VERSION on any edit — it is part of the Claude prompt-cache key
and is recorded in audit_log so every post is traceable to a fact-base state.
Keep claims literally true and conservative. When unsure, delete the line.
-->

`;
  writeFileSync(join(fb, "facts.md"), header + facts.trim() + "\n\n" + style);

  writeFileSync(
    join(fb, "banned-claims.json"),
    j({
      _comment:
        "PRODUCT-specific guardrail config (engine-generic patterns merge in from templates/banned-claims.base.json). DRAFT — review each pattern; they BLOCK copy on match.",
      allowedPriceTokens: a.priceTokens,
      allowedDomains: [a.domain],
      bannedPhrases: guard.bannedPhrases,
      requireSingleCanonicalLink: true,
      maxEmoji: 1,
    }),
  );
  writeFileSync(join(fb, "social-evergreen.json"), j({ angles: plan.angles }));
  writeFileSync(join(fb, "seo-pages.json"), j({ pages: plan.seoPages }));
  writeFileSync(join(fb, "comparisons.json"), j({ comparisons: plan.comparisons }));
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  if (!existsSync(args.repo) || !statSync(args.repo).isDirectory())
    throw new Error(`--repo is not a directory: ${args.repo}`);
  // A workspace folder full of repos yields empty evidence, and the drafting
  // model (correctly) refuses to invent facts from nothing — catch it BEFORE
  // any paid drafting and point at the likely repos inside.
  if (!looksLikeRepo(args.repo)) {
    const candidates = readdirSync(args.repo, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .filter((e) => looksLikeRepo(join(args.repo, e.name)))
      .map((e) => e.name);
    throw new Error(
      `${args.repo} doesn't look like a product source repo (no README, build manifest, Xcode project, or .git).` +
        (candidates.length
          ? ` It does contain repos — did you mean one of: ${candidates.join(", ")}? Point --repo at the product's own source repo.`
          : ""),
    );
  }
  if (args.vault && (!existsSync(args.vault) || !statSync(args.vault).isDirectory()))
    throw new Error(`--vault is not a directory: ${args.vault}`);
  if (existsSync(join(args.out, "product.json")))
    throw new Error(
      `${args.out}/product.json already exists — refusing to overwrite a configured product. Pass --out <fresh-dir> (and later swap it in, or point PRODUCT_DIR at it).`,
    );

  console.log(`[setup] analyzing repo ${args.repo} ...`);
  const repoEv = gatherRepoEvidence(args.repo);
  const vaultEv = args.vault ? await gatherVaultEvidence(args.vault) : "";

  const a = await interview(repoEv, args.answersFile);

  // A failed later stage must not throw away the earlier (paid) drafts:
  // facts are essential, guardrails/plan degrade to empty with a warning and
  // can be filled by hand or by re-running setup with --out.
  console.log(`\n[setup] drafting fact base (${env.genModel}) ...`);
  const facts = await draftFacts(repoEv, vaultEv, a);
  console.log(`[setup] drafting guardrails ...`);
  let guard: GuardrailDraft = { bannedPhrases: [], criticNotes: [] };
  try {
    guard = await draftGuardrails(repoEv, vaultEv, a);
  } catch (e) {
    console.warn(`[setup] WARNING: guardrail drafting failed (${(e as Error).message}) — banned-claims.json will carry only the engine base patterns; add product patterns by hand.`);
  }
  console.log(`[setup] drafting content plan ...`);
  let plan: ContentDraft = { angles: [], seoPages: [], comparisons: [] };
  try {
    plan = await draftContentPlan(repoEv, vaultEv, a);
  } catch (e) {
    console.warn(`[setup] WARNING: content-plan drafting failed (${(e as Error).message}) — angle/SEO/comparison files will be empty; add entries via the dashboard.`);
  }
  if (plan.angles.length === 0)
    console.warn("[setup] WARNING: no valid evergreen angles — add some by hand (the drip needs at least one).");

  writeProductDir(args.out, a, facts, guard, plan);
  // Persist the interview so a re-run is one flag away, never a retype:
  //   npm run setup -- --repo <repo> --answers <out>/setup-answers.json --out <fresh-dir>
  writeFileSync(join(args.out, "setup-answers.json"), JSON.stringify(a, null, 2) + "\n");

  const todos = (facts.match(/TODO\(verify\)/g) ?? []).length;
  console.log(`
[setup] DRAFT product written to ${args.out}
        facts.md: ${todos} TODO(verify) marker(s) to resolve
        angles: ${plan.angles.length} · seo pages: ${plan.seoPages.length} · comparisons: ${plan.comparisons.length}

Next steps (the engine stays dry-run-only until step 4):
  1. Read + fix ${args.out}/factbase/facts.md — resolve every TODO, delete
     anything not literally true. Review banned-claims.json and product.json.
  2. Create this instance's env: cp .env.example .env.local (own DATABASE_URL,
     own PORT), then: npm run db:migrate
  3. Verify the pipeline end-to-end without publishing: npm run dryrun
  4. Open the dashboard (npm run dev) → Overview → "I reviewed the fact base"
     — only then do DRY_RUN / LIVE_CHANNELS start to matter.
`);
}

main().catch((e) => {
  console.error(`[setup] FATAL: ${(e as Error).message}`);
  process.exit(1);
});
