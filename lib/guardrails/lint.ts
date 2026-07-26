import { loadBanned } from "@/lib/sources/factbase";
import { channelDef, socialLimit } from "@/lib/channels";

export interface LintContext {
  channel: string;
  /** The exact UTM-tagged URL the engine intends; must be the only link. */
  expectedUrl: string;
  /** Verbatim release notes, when this is a release post (version allowlist). */
  releaseNotes?: string;
  /** The release tag itself — engine-supplied ground truth. The generated
   *  copy is INSTRUCTED to state this version (changelog H2), and notes
   *  bodies rarely repeat their own version, so it must be allowlisted. */
  releaseTag?: string;
}

export interface LintResult {
  ok: boolean;
  violations: string[];
}

const URL_RE = /https?:\/\/[^\s)\]]+/gi;
// $, €, £ amounts. Currencies beyond the tokens a product allows only make
// the gate stricter (any unlisted amount blocks).
const PRICE_RE = /[$€£]\s?\d[\d,]*(?:\.\d+)?/g;
const VERSION_RE = /\bv?\d+\.\d+\.\d+\b/g;
// Rough emoji detection (pictographic ranges).
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/**
 * Deterministic, no-LLM gate. Any violation BLOCKS the text. This is the
 * single most important safety layer — it cannot hallucinate.
 */
export function lint(text: string, ctx: LintContext): LintResult {
  const v: string[] = [];
  const banned = loadBanned();
  const lower = text.toLowerCase();

  // 1. Banned phrases / intentions.
  for (const pat of banned.bannedPhrases) {
    if (new RegExp(pat, "i").test(lower)) v.push(`banned phrase: /${pat}/`);
  }

  // 2. Pricing allowlist — every $-amount must be explicitly allowed.
  for (const tok of text.match(PRICE_RE) ?? []) {
    // [\d,]* exists for thousands separators but also swallows a trailing
    // sentence comma ("regular $29, lifetime") — strip it before comparing.
    const norm = tok.replace(/\s/g, "").replace(/,+$/, "");
    if (!banned.allowedPriceTokens.includes(norm))
      v.push(`disallowed price token: ${norm}`);
  }

  // 3. Version allowlist — any vX.Y.Z must be the engine-supplied release tag
  // or appear in the supplied release notes.
  const notes = ctx.releaseNotes ?? "";
  const tagBare = (ctx.releaseTag ?? "").replace(/^v/, "");
  for (const ver of text.match(VERSION_RE) ?? []) {
    const bare = ver.replace(/^v/, "");
    if (tagBare && bare === tagBare) continue;
    if (notes && (notes.includes(bare) || notes.includes(ver))) continue;
    v.push(
      notes || tagBare
        ? `version token not in release notes: ${ver}`
        : `version token(s) ${ver} but no release notes supplied`,
    );
  }

  // 4. Exactly one link, equal to the expected UTM URL, on an allowed domain.
  // Changelog is the exception: its page renders the CTA button from the
  // JSON url field, so the BODY must contain no link at all.
  const urls = text.match(URL_RE) ?? [];
  if (banned.requireSingleCanonicalLink) {
    const expected = ctx.channel === "changelog" ? 0 : 1;
    if (urls.length !== expected)
      v.push(`expected exactly ${expected} link(s) for ${ctx.channel}, found ${urls.length}`);
    if (expected === 1 && urls[0] && urls[0].replace(/[.,)]+$/, "") !== ctx.expectedUrl)
      v.push(`link is not the engine-supplied UTM URL`);
    for (const u of urls) {
      let host = "";
      try {
        host = new URL(u).host;
      } catch {
        v.push(`unparseable URL: ${u}`);
        continue;
      }
      if (!banned.allowedDomains.some((d) => host === d || host.endsWith("." + d)))
        v.push(`link host not allowed: ${host}`);
    }
  }

  // 4b. Markdown content must open with its heading — anything before it is
  // preamble/narration that normalize.ts couldn't safely strip.
  const hr = channelDef(ctx.channel)?.headingRe;
  if (hr && !hr.test(text.trimStart()))
    v.push(`content must start with a markdown heading (${ctx.channel})`);

  // 5. Emoji ceiling.
  const emoji = (text.match(EMOJI_RE) ?? []).length;
  if (emoji > banned.maxEmoji)
    v.push(`too many emoji: ${emoji} > ${banned.maxEmoji}`);

  // 6. Length ceiling for social channels.
  const limit = socialLimit(ctx.channel);
  if (limit && text.length > limit)
    v.push(`length ${text.length} exceeds ${ctx.channel} limit ${limit}`);

  // 7. Non-empty.
  if (text.trim().length < 20) v.push(`output too short / empty`);

  return { ok: v.length === 0, violations: v };
}
