"use server";

// Form-based editing for the product files. Each action reads the current
// file, applies the form's changes, VALIDATES the result, and only then
// writes — a bad submission is rejected with the specific problem (an
// invalid product.json would take the dashboard down; an invalid regex
// would crash the linter). Every save is audited.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { redirect } from "next/navigation";
import { productDir, validateProductConfig } from "@/lib/product";
import { normalizeRepo } from "@/lib/setup";
import { audit } from "@/lib/audit";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const list = (fd: FormData, k: string) =>
  s(fd, k)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const lines = (fd: FormData, k: string) =>
  String(fd.get(k) ?? "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

const kebabOk = (x: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(x);

function back(anchor: string, kind: "msg" | "err", text: string): never {
  redirect(`/files?${kind}=${encodeURIComponent(text)}#${anchor}`);
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

async function saved(anchor: string, file: string): Promise<never> {
  await audit("dashboard", "product_file_updated", { file }, { level: "warn" });
  back(anchor, "msg", `${file} saved — takes effect on the next tick`);
}

// ---------------------------------------------------------------------------
// product.json

export async function saveProductConfigAction(formData: FormData) {
  const path = resolve(productDir(), "product.json");
  const current = readJson(path);

  let github;
  try {
    github = {
      releasesRepo: normalizeRepo(s(formData, "releasesRepo")) || normalizeRepo(s(formData, "websiteRepo")),
      websiteRepo: normalizeRepo(s(formData, "websiteRepo")),
      websiteBranch: s(formData, "websiteBranch") || "main",
    };
  } catch (e) {
    back("product", "err", (e as Error).message);
  }

  const currentSite = (current.site ?? {}) as Record<string, unknown>;
  const dirs = (currentSite.contentDirs ?? {}) as Record<string, string>;
  const paths = (currentSite.urlPaths ?? {}) as Record<string, string>;
  for (const ch of ["changelog", "blog", "seo", "comparison"]) {
    const d = s(formData, `dir_${ch}`);
    const u = s(formData, `url_${ch}`);
    if (d) dirs[ch] = d;
    if (u) paths[ch] = u.startsWith("/") ? u : `/${u}`;
  }

  const next = {
    ...current, // preserves _comment, reviewed, and anything unknown
    name: s(formData, "name"),
    slug: s(formData, "slug") || s(formData, "name").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    domain: s(formData, "domain"),
    siteUrl: s(formData, "siteUrl") || `https://${s(formData, "domain")}`,
    github,
    cta: {
      release: s(formData, "ctaRelease") || "/",
      seo: s(formData, "ctaSeo") || "/",
      comparison: s(formData, "ctaComparison") || "/",
    },
    site: {
      format: s(formData, "format") === "json" ? "json" : "markdown",
      contentDirs: dirs,
      urlPaths: paths,
    },
    releases: {
      tagScheme: s(formData, "tagScheme") === "any" ? "any" : "semver",
      socialMaxAgeDays: Number(s(formData, "socialMaxAgeDays")) || 14,
      rollupPatchCount: Number(s(formData, "rollupPatchCount")) || 3,
    },
    socialTargets: formData.getAll("socialTargets").map(String),
    criticNotes: lines(formData, "criticNotes"),
  };

  try {
    validateProductConfig(next);
  } catch (e) {
    back("product", "err", (e as Error).message);
  }
  writeJson(path, next);
  await saved("product", "product.json");
}

// ---------------------------------------------------------------------------
// banned-claims.json

const BANNED_PATH = () => resolve(productDir(), "factbase", "banned-claims.json");

/** Prices/domains/emoji/link settings — phrases are managed separately. */
export async function saveGuardrailsAction(formData: FormData) {
  const path = BANNED_PATH();
  const current = readJson(path);

  const maxEmoji = Number(s(formData, "maxEmoji"));
  if (!Number.isInteger(maxEmoji) || maxEmoji < 0)
    back("banned-claims", "err", "max emoji must be 0 or more");
  const domains = list(formData, "allowedDomains");
  if (domains.length === 0)
    back("banned-claims", "err", "at least one allowed domain is required (links must live somewhere)");

  writeJson(path, {
    ...current,
    allowedPriceTokens: list(formData, "allowedPriceTokens"),
    allowedDomains: domains,
    requireSingleCanonicalLink: formData.get("requireSingleCanonicalLink") === "on",
    maxEmoji,
  });
  await saved("banned-claims", "banned-claims.json");
}

const REGEX_META = /[\\()[\]|+*?^${}]/;

/** Plain text stays plain (matching is case-insensitive substring); anything
 *  with regex syntax must compile. */
function checkPhrase(p: string): string | null {
  if (!REGEX_META.test(p)) return null;
  try {
    new RegExp(p, "i");
    return null;
  } catch {
    return `not a valid pattern: ${p}`;
  }
}

export async function addBannedPhraseAction(formData: FormData) {
  const phrase = s(formData, "phrase").toLowerCase();
  if (phrase.length < 2) back("banned-claims", "err", "phrase is too short");
  const problem = checkPhrase(phrase);
  if (problem) back("banned-claims", "err", problem);

  const path = BANNED_PATH();
  const current = readJson(path);
  const phrases = (Array.isArray(current.bannedPhrases) ? current.bannedPhrases : []) as string[];
  if (phrases.includes(phrase)) back("banned-claims", "err", "already in the list");
  writeJson(path, { ...current, bannedPhrases: [...phrases, phrase] });
  await saved("banned-claims", "banned-claims.json");
}

export async function removeBannedPhraseAction(formData: FormData) {
  const phrase = String(formData.get("phrase") ?? "");
  const path = BANNED_PATH();
  const current = readJson(path);
  const phrases = (Array.isArray(current.bannedPhrases) ? current.bannedPhrases : []) as string[];
  writeJson(path, { ...current, bannedPhrases: phrases.filter((p) => p !== phrase) });
  await saved("banned-claims", "banned-claims.json");
}

/** Power-user bulk editor (one pattern per line), kept out of the main flow. */
export async function bulkBannedPhrasesAction(formData: FormData) {
  const patterns = lines(formData, "bannedPhrases");
  for (const p of patterns) {
    const problem = checkPhrase(p);
    if (problem) back("banned-claims", "err", problem);
  }
  const path = BANNED_PATH();
  const current = readJson(path);
  writeJson(path, { ...current, bannedPhrases: patterns });
  await saved("banned-claims", "banned-claims.json");
}

// ---------------------------------------------------------------------------
// seo-pages.json + comparisons.json (list editing: upsert / remove)

interface SeoPage {
  slug: string;
  audience: string;
  intent: string;
  primaryFeature: string;
}

export async function seoPageAction(formData: FormData) {
  const path = resolve(productDir(), "factbase", "seo-pages.json");
  const current = readJson(path);
  const pages = (Array.isArray(current.pages) ? current.pages : []) as SeoPage[];
  const original = s(formData, "originalSlug");
  const op = s(formData, "op");

  if (op === "remove") {
    writeJson(path, { ...current, pages: pages.filter((p) => p.slug !== original) });
    await saved("seo-pages", "seo-pages.json");
  }

  const page: SeoPage = {
    slug: s(formData, "slug"),
    audience: s(formData, "audience"),
    intent: s(formData, "intent"),
    primaryFeature: s(formData, "primaryFeature"),
  };
  if (!kebabOk(page.slug)) back("seo-pages", "err", "slug must be kebab-case (letters, digits, hyphens)");
  if (!page.audience || !page.intent || !page.primaryFeature)
    back("seo-pages", "err", "audience, intent, and feature are all required");
  if (page.slug !== original && pages.some((p) => p.slug === page.slug))
    back("seo-pages", "err", `a page with slug "${page.slug}" already exists`);

  const idx = pages.findIndex((p) => p.slug === original);
  if (idx >= 0) pages[idx] = page;
  else pages.push(page);
  writeJson(path, { ...current, pages });
  await saved("seo-pages", "seo-pages.json");
}

interface Comparison {
  slug: string;
  category: string;
  angle: string;
}

export async function comparisonAction(formData: FormData) {
  const path = resolve(productDir(), "factbase", "comparisons.json");
  const current = readJson(path);
  const comparisons = (Array.isArray(current.comparisons) ? current.comparisons : []) as Comparison[];
  const original = s(formData, "originalSlug");
  const op = s(formData, "op");

  if (op === "remove") {
    writeJson(path, { ...current, comparisons: comparisons.filter((c) => c.slug !== original) });
    await saved("comparisons", "comparisons.json");
  }

  const item: Comparison = {
    slug: s(formData, "slug"),
    category: s(formData, "category"),
    angle: s(formData, "angle"),
  };
  if (!kebabOk(item.slug)) back("comparisons", "err", "slug must be kebab-case (letters, digits, hyphens)");
  if (!item.category || !item.angle) back("comparisons", "err", "category and angle are both required");
  if (item.slug !== original && comparisons.some((c) => c.slug === item.slug))
    back("comparisons", "err", `a comparison with slug "${item.slug}" already exists`);

  const idx = comparisons.findIndex((c) => c.slug === original);
  if (idx >= 0) comparisons[idx] = item;
  else comparisons.push(item);
  writeJson(path, { ...current, comparisons });
  await saved("comparisons", "comparisons.json");
}
