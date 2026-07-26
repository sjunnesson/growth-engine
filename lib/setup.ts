/**
 * Product onboarding core — shared by the CLI wizard (scripts/setup.ts) and
 * the dashboard Setup page (app/setup). Analyzes the product's source repo
 * (and optionally an Obsidian vault) with the Claude Code CLI, then drafts
 * the complete product directory. Everything it writes is a DRAFT:
 * product.json ships reviewed=false, which forces every channel to dry-run
 * until a human signs off in the dashboard. The generation prompts are
 * closed-world (assert only what the evidence supports; mark gaps
 * TODO(verify)) but the REAL guarantee is that review step — never weaken it.
 *
 * Long runs report progress through a status file (SETUP_STATUS_FILE) so a
 * web UI can poll while the run happens in a detached child process.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { runClaude } from "@/lib/claude/cli";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// answers

export interface Answers {
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

export const kebab = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Accept owner/repo in any common spelling: bare, full https URL, git URL,
 *  trailing .git. The engine needs the bare "owner/repo" form. */
export function normalizeRepo(input: string): string {
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

export function defaultAnswers(): Answers {
  return {
    name: "",
    slug: "",
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
}

/** Fill derived fields, normalize repos, enforce required fields. Shared by
 *  the CLI --answers path and the dashboard form. */
export function finalizeAnswers(given: Partial<Answers>): Answers {
  const a = { ...defaultAnswers(), ...given };
  for (const k of ["name", "domain", "websiteRepo"] as const) {
    if (!a[k]) throw new Error(`missing required field: ${k}`);
  }
  a.slug = kebab(a.slug || a.name);
  a.siteUrl = a.siteUrl || `https://${a.domain}`;
  a.websiteRepo = normalizeRepo(a.websiteRepo);
  a.releasesRepo = normalizeRepo(a.releasesRepo) || a.websiteRepo;
  a.format = a.format === "json" ? "json" : "markdown";
  a.tagScheme = a.tagScheme === "any" ? "any" : "semver";
  return a;
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
export function looksLikeRepo(dir: string): boolean {
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

/** Repos inside a directory that isn't itself a repo — for "did you mean". */
export function repoCandidates(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .filter((e) => looksLikeRepo(join(dir, e.name)))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Bounded, deterministic sweep of the product repo: README, manifests,
 *  top-level docs, release tags. No LLM here — this just assembles evidence. */
export function gatherRepoEvidence(repo: string): string {
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
  const docs = top.filter((f) => f.endsWith(".md") && !/^readme/i.test(f));
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
export async function gatherVaultEvidence(vault: string): Promise<string> {
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

export interface GuardrailDraft {
  bannedPhrases: string[];
  criticNotes: string[];
}

async function draftGuardrails(repoEv: string, vaultEv: string, a: Answers): Promise<GuardrailDraft> {
  const system = `You write PRODUCT-SPECIFIC guardrail patterns for a marketing-copy linter (case-insensitive substring/regex match blocks the copy). Generic hype/AI-slop patterns already exist; produce only what is specific to THIS product:
- Claims this product's pricing model forbids (e.g. calling a capped free tier "unlimited" or "free forever").
- Characterizations of the named competitors ("better than X", "X is slow/bad/expensive").
- Anything in the operator's never-claim list.
STRONGLY prefer plain lowercase phrases ("free forever", "no credit card") — the operator reads and edits this list, and matching is substring-based so plain text works. Use regex syntax ONLY when alternation genuinely earns its keep, and keep it simple.
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

export interface ContentDraft {
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
      "Generated by setup — a DRAFT until reviewed=true (flip it in the dashboard after checking factbase/). Env vars GITHUB_RELEASES_REPO / GITHUB_WEBSITE_REPO / GITHUB_WEBSITE_BRANCH / SITE_URL override their fields here.",
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

  const style = readFileSync(resolve(process.cwd(), "templates", "facts-style.md"), "utf-8")
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
// orchestration + status

export interface SetupResult {
  out: string;
  todos: number;
  angles: number;
  seoPages: number;
  comparisons: number;
  warnings: string[];
}

export interface SetupStatus {
  stage:
    | "analyzing"
    | "vault"
    | "facts"
    | "guardrails"
    | "plan"
    | "writing"
    | "done"
    | "error";
  detail?: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
  result?: SetupResult;
}

/** Default status-file location, repo-root relative (gitignored). */
export const SETUP_STATUS_FILE = ".setup-status.json";

export function readSetupStatus(file = SETUP_STATUS_FILE): SetupStatus | null {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), file), "utf-8"));
  } catch {
    return null;
  }
}

export interface RunOptions {
  repo: string;
  vault?: string;
  out: string;
  answers: Answers;
  /** Where to write progress for a polling UI; null = no status file. */
  statusFile?: string | null;
}

/** The full onboarding run. Throws on fatal errors (bad repo, facts failed);
 *  guardrails/plan degrade to empty output with a warning instead of
 *  discarding the earlier (paid) drafts. */
export async function runOnboarding(opts: RunOptions): Promise<SetupResult> {
  const startedAt = new Date().toISOString();
  const status = (s: Omit<SetupStatus, "startedAt" | "updatedAt">) => {
    if (!opts.statusFile) return;
    const full: SetupStatus = { ...s, startedAt, updatedAt: new Date().toISOString() };
    try {
      writeFileSync(resolve(process.cwd(), opts.statusFile), JSON.stringify(full, null, 2) + "\n");
    } catch {
      /* status is best-effort */
    }
  };

  try {
    if (!looksLikeRepo(opts.repo)) {
      const candidates = repoCandidates(opts.repo);
      throw new Error(
        `${opts.repo} doesn't look like a product source repo (no README, build manifest, Xcode project, or .git).` +
          (candidates.length
            ? ` It does contain repos — did you mean one of: ${candidates.join(", ")}? Point at the product's own source repo.`
            : ""),
      );
    }
    if (existsSync(join(opts.out, "product.json")))
      throw new Error(
        `${opts.out}/product.json already exists — refusing to overwrite a configured product. Choose a fresh output dir.`,
      );

    status({ stage: "analyzing", detail: opts.repo });
    console.log(`[setup] analyzing repo ${opts.repo} ...`);
    const repoEv = gatherRepoEvidence(opts.repo);

    let vaultEv = "";
    if (opts.vault) {
      status({ stage: "vault", detail: opts.vault });
      vaultEv = await gatherVaultEvidence(opts.vault);
    }

    const a = opts.answers;
    const warnings: string[] = [];

    status({ stage: "facts" });
    console.log(`\n[setup] drafting fact base (${env.genModel}) ...`);
    const facts = await draftFacts(repoEv, vaultEv, a);

    status({ stage: "guardrails" });
    console.log(`[setup] drafting guardrails ...`);
    let guard: GuardrailDraft = { bannedPhrases: [], criticNotes: [] };
    try {
      guard = await draftGuardrails(repoEv, vaultEv, a);
    } catch (e) {
      warnings.push(`guardrail drafting failed (${(e as Error).message}) — banned-claims.json carries only the engine base patterns; add product patterns by hand.`);
    }

    status({ stage: "plan" });
    console.log(`[setup] drafting content plan ...`);
    let plan: ContentDraft = { angles: [], seoPages: [], comparisons: [] };
    try {
      plan = await draftContentPlan(repoEv, vaultEv, a);
    } catch (e) {
      warnings.push(`content-plan drafting failed (${(e as Error).message}) — angle/SEO/comparison files are empty; add entries via the dashboard.`);
    }
    if (plan.angles.length === 0)
      warnings.push("no valid evergreen angles — add some by hand (the drip needs at least one).");

    status({ stage: "writing" });
    writeProductDir(opts.out, a, facts, guard, plan);
    writeFileSync(join(opts.out, "setup-answers.json"), JSON.stringify(a, null, 2) + "\n");

    const result: SetupResult = {
      out: opts.out,
      todos: (facts.match(/TODO\(verify\)/g) ?? []).length,
      angles: plan.angles.length,
      seoPages: plan.seoPages.length,
      comparisons: plan.comparisons.length,
      warnings,
    };
    for (const w of warnings) console.warn(`[setup] WARNING: ${w}`);
    status({ stage: "done", result });
    return result;
  } catch (e) {
    status({ stage: "error", error: (e as Error).message });
    throw e;
  }
}
