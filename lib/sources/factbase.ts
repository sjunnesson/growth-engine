import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { productDir } from "@/lib/product";

const FB = (f: string) => resolve(productDir(), "factbase", f);
const BASE_BANNED = resolve(process.cwd(), "templates", "banned-claims.base.json");

export interface BannedConfig {
  allowedPriceTokens: string[];
  allowedDomains: string[];
  bannedPhrases: string[];
  requireSingleCanonicalLink: boolean;
  maxEmoji: number;
}

export interface EvergreenAngle {
  id: string;
  brief: string;
  cta: string;
}
export interface SeoPage {
  slug: string;
  audience: string;
  intent: string;
  primaryFeature: string;
}
export interface Comparison {
  slug: string;
  category: string;
  angle: string;
}

let _cache: { mtimeMs: number; facts: string; version: string } | null = null;

/** The fact-base markdown + its FACTBASE_VERSION (used as prompt-cache key).
 *  Cached per mtime — the runner is long-lived, so a dashboard fact edit must
 *  reach the very next generation without a restart. */
export function loadFacts(): { facts: string; version: string } {
  const f = FB("facts.md");
  const mtimeMs = statSync(f).mtimeMs;
  if (_cache && _cache.mtimeMs === mtimeMs)
    return { facts: _cache.facts, version: _cache.version };
  const facts = readFileSync(f, "utf-8");
  const m = facts.match(/FACTBASE_VERSION:\s*([^\s]+)/);
  _cache = { mtimeMs, facts, version: m?.[1] ?? "unknown" };
  return { facts, version: _cache.version };
}

/** Product guardrail config merged with the engine-level base patterns
 *  (templates/banned-claims.base.json): AI-slop style rules are engine-owned
 *  and apply to every product; the product file carries pricing/competitor/
 *  domain specifics. Set "inheritBase": false in the product file to opt out. */
export function loadBanned(): BannedConfig {
  const prod = JSON.parse(readFileSync(FB("banned-claims.json"), "utf-8")) as
    BannedConfig & { inheritBase?: boolean };
  if (prod.inheritBase === false) return prod;
  const base = JSON.parse(readFileSync(BASE_BANNED, "utf-8")) as {
    bannedPhrases: string[];
  };
  return {
    ...prod,
    bannedPhrases: [...new Set([...base.bannedPhrases, ...prod.bannedPhrases])],
  };
}

export function loadEvergreen(): EvergreenAngle[] {
  return JSON.parse(readFileSync(FB("social-evergreen.json"), "utf-8")).angles;
}
export function loadSeoPages(): SeoPage[] {
  return JSON.parse(readFileSync(FB("seo-pages.json"), "utf-8")).pages;
}
export function loadComparisons(): Comparison[] {
  return JSON.parse(readFileSync(FB("comparisons.json"), "utf-8")).comparisons;
}
