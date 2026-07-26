// Product/instance configuration. One engine checkout serves ONE product;
// everything product-specific lives in the product directory (default
// <cwd>/product, override with PRODUCT_DIR):
//   product/product.json  — identity, repos, site layout, channel targets
//   product/factbase/*    — the closed world (facts.md + guardrail data)
// The engine code itself must stay product-agnostic: any new product-specific
// string belongs here or in the factbase, never in lib/.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ProductConfig {
  /** Display name used in prompts and copy, e.g. "Acme". */
  name: string;
  /** Kebab-case id: commit-message tags, idempotency-key prefixes, generatedBy. */
  slug: string;
  /** Apex domain all generated links must live on, e.g. "acme.example". */
  domain: string;
  /** Canonical site origin, e.g. "https://acme.example". */
  siteUrl: string;
  github: {
    /** owner/repo whose GitHub Releases feed the changelog + release social. */
    releasesRepo: string;
    /** owner/repo the engine commits generated content files into. */
    websiteRepo: string;
    websiteBranch: string;
  };
  /** Site-relative CTA paths per source kind (evergreen CTAs live on angles). */
  cta: { release: string; seo: string; comparison: string };
  site: {
    /** How content files are written into the website repo. */
    format: "json" | "markdown";
    /** Repo directory per content channel, e.g. changelog -> content/changelog. */
    contentDirs: Record<string, string>;
    /** Public URL path prefix per content channel, e.g. seo -> /use. */
    urlPaths: Record<string, string>;
  };
  releases: {
    /** "semver": patch-collapse applies. "any": every release is announceable. */
    tagScheme: "semver" | "any";
    /** Don't socially announce releases older than this (backfill noise). */
    socialMaxAgeDays: number;
    /** Patches accumulated since the last minor before a rollup post (semver). */
    rollupPatchCount: number;
  };
  /** Social channels the engine currently enqueues for (phased rollout). */
  socialTargets: string[];
  /** Product-specific cautions appended to the LLM critic's instructions. */
  criticNotes?: string[];
  /** Setup wizard writes false. Until an operator flips it in the dashboard,
   *  every channel behaves as dry-run — nothing can leave the machine on an
   *  unreviewed factbase. */
  reviewed: boolean;
}

export function productDir(): string {
  return process.env.PRODUCT_DIR
    ? resolve(process.env.PRODUCT_DIR)
    : resolve(process.cwd(), "product");
}

const file = () => resolve(productDir(), "product.json");

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim())
    throw new Error(`product.json: ${where}${key} must be a non-empty string`);
  return v.trim();
}

function validate(raw: unknown): ProductConfig {
  if (!raw || typeof raw !== "object")
    throw new Error("product.json: not an object");
  const o = raw as Record<string, unknown>;
  const gh = (o.github ?? {}) as Record<string, unknown>;
  const cta = (o.cta ?? {}) as Record<string, unknown>;
  const site = (o.site ?? {}) as Record<string, unknown>;
  const rel = (o.releases ?? {}) as Record<string, unknown>;
  const cfg: ProductConfig = {
    name: str(o, "name", ""),
    slug: str(o, "slug", ""),
    domain: str(o, "domain", ""),
    siteUrl: str(o, "siteUrl", ""),
    github: {
      releasesRepo: str(gh, "releasesRepo", "github."),
      websiteRepo: str(gh, "websiteRepo", "github."),
      websiteBranch: str(gh, "websiteBranch", "github."),
    },
    cta: {
      release: str(cta, "release", "cta."),
      seo: str(cta, "seo", "cta."),
      comparison: str(cta, "comparison", "cta."),
    },
    site: {
      format: site.format === "markdown" ? "markdown" : "json",
      contentDirs: (site.contentDirs ?? {}) as Record<string, string>,
      urlPaths: (site.urlPaths ?? {}) as Record<string, string>,
    },
    releases: {
      tagScheme: rel.tagScheme === "any" ? "any" : "semver",
      socialMaxAgeDays: Number(rel.socialMaxAgeDays) || 14,
      rollupPatchCount: Number(rel.rollupPatchCount) || 3,
    },
    socialTargets: Array.isArray(o.socialTargets)
      ? (o.socialTargets as string[]).map(String)
      : [],
    criticNotes: Array.isArray(o.criticNotes)
      ? (o.criticNotes as string[]).map(String)
      : [],
    reviewed: o.reviewed === true,
  };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(cfg.slug))
    throw new Error(`product.json: slug "${cfg.slug}" must be kebab-case`);
  return cfg;
}

/** Ops overrides keep working: env beats product.json for repo/site targets. */
function withEnvOverrides(cfg: ProductConfig): ProductConfig {
  return {
    ...cfg,
    siteUrl: process.env.SITE_URL || cfg.siteUrl,
    github: {
      releasesRepo: process.env.GITHUB_RELEASES_REPO || cfg.github.releasesRepo,
      websiteRepo: process.env.GITHUB_WEBSITE_REPO || cfg.github.websiteRepo,
      websiteBranch: process.env.GITHUB_WEBSITE_BRANCH || cfg.github.websiteBranch,
    },
  };
}

let _cache: { mtimeMs: number; cfg: ProductConfig } | null = null;

/** Is a product configured in this checkout yet? False on a fresh clone —
 *  the dashboard steers to /setup and the tick idles instead of crashing. */
export function isConfigured(): boolean {
  return existsSync(file());
}

/** product(), or null when this checkout has no product yet (fresh clone).
 *  UI code uses this; pipeline code keeps the throwing product(). */
export function productOrNull(): ProductConfig | null {
  try {
    return product();
  } catch {
    return null;
  }
}

/** The product config, reloaded when product.json changes on disk (the runner
 *  is a long-lived process; a stale-forever cache would hide edits). */
export function product(): ProductConfig {
  const f = file();
  const mtimeMs = statSync(f).mtimeMs;
  if (_cache && _cache.mtimeMs === mtimeMs) return _cache.cfg;
  const cfg = withEnvOverrides(validate(JSON.parse(readFileSync(f, "utf-8"))));
  _cache = { mtimeMs, cfg };
  return cfg;
}

/** Operator sign-off on a setup-generated (or re-generated) factbase. Until
 *  this is true, pipeline.effectiveLive() forces every channel to dry-run. */
export function markReviewed(): { ok: boolean; message: string } {
  const f = file();
  const raw = JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>;
  if (raw.reviewed === true) return { ok: false, message: "already marked reviewed" };
  raw.reviewed = true;
  writeFileSync(f, JSON.stringify(raw, null, 2) + "\n");
  _cache = null;
  return { ok: true, message: "product marked reviewed — live posture now follows DRY_RUN/LIVE_CHANNELS" };
}
