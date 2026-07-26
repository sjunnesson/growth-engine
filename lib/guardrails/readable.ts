// Human rendering of guardrail machinery for the dashboard: patterns as
// readable phrases, and a blocked row's stored metadata as a plain-language
// explanation of WHY it was declined.

/** Human rendering of a guardrail pattern: regex plumbing (\b, \s+, escapes,
 *  non-capturing groups) becomes plain text; alternations keep their pipes.
 *  Falls back to the raw pattern when it uses constructs we can't simplify. */
export function readablePattern(p: string): { text: string; isRegex: boolean } {
  if (!/[\\()[\]|+*?^${}]/.test(p)) return { text: p, isRegex: false };
  const simplified = p
    .replace(/\\b/g, "")
    .replace(/\\s[+*]/g, " ")
    .replace(/\[[-\s]+\]/g, " ")
    .replace(/\(\?:/g, "(")
    .replace(/\\([$€£%'./-])/g, "$1")
    .replace(/'\??/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const test = simplified.replace(/[()|]/g, "");
  if (/[\\[\]+*?^${}]/.test(test)) return { text: p, isRegex: true };
  return { text: simplified, isRegex: true };
}

/** One stored lint violation → plain language. Unknown shapes pass through
 *  (they're already sentences). */
export function readableViolation(v: string): string {
  let m = v.match(/^banned phrase: \/(.+)\/$/s);
  if (m) return `contains a blocked phrase: “${readablePattern(m[1]).text.replace(/\|/g, " | ")}”`;
  m = v.match(/^disallowed price token: (.+)$/);
  if (m) return `mentions a price that isn't on the allowed list: ${m[1]}`;
  m = v.match(/^length (\d+) exceeds (\w+) limit (\d+)$/);
  if (m) return `too long for ${m[2]}: ${m[1]} characters (limit ${m[3]})`;
  m = v.match(/^version token not in release notes: (.+)$/);
  if (m) return `mentions a version (${m[1]}) that isn't in the release notes`;
  m = v.match(/^too many emoji: (\d+) > (\d+)$/);
  if (m) return `too many emoji: ${m[1]} (limit ${m[2]})`;
  if (v === "link is not the engine-supplied UTM URL")
    return "the link differs from the tracking link the engine supplied";
  return v;
}

export interface BlockReason {
  /** Which gate declined it. */
  gate: "guardrails" | "ai-reviewer";
  summary: string;
  details: string[];
}

/** Why a row ended up skipped, extracted from its stored metadata. Returns
 *  null when the row wasn't declined by a gate (failed rows carry their own
 *  last_error). */
export function blockReason(meta: Record<string, unknown> | null): BlockReason | null {
  if (!meta) return null;
  const lint = meta.lint;
  if (Array.isArray(lint) && lint.length > 0) {
    const details = (lint as string[]).map(readableViolation);
    return {
      gate: "guardrails",
      summary: details[0] + (details.length > 1 ? ` (+${details.length - 1} more)` : ""),
      details,
    };
  }
  const critic = meta.critic as { verdict?: string; reason?: string } | undefined;
  if (critic?.verdict === "block") {
    return {
      gate: "ai-reviewer",
      summary: critic.reason || "the AI reviewer declined it without a stated reason",
      details: [critic.reason || ""],
    };
  }
  return null;
}
