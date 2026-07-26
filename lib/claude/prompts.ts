// Builds the small VARIABLE user message per job. The large stable rules +
// fact-base live in the cached system prefix (lib/claude/cache.ts).
import { product } from "@/lib/product";
import { socialLimit } from "@/lib/channels";

export interface GenJob {
  channel: string; // mastodon|bluesky|linkedin|reddit|x|changelog|blog|seo|comparison
  sourceKind: string; // release|evergreen|comparison|seo
  /** UTM-tagged canonical URL the engine wants linked (exactly one). */
  url: string;
  /** Verbatim release notes, when sourceKind=release. Treated as factual. */
  releaseNotes?: string;
  /** Release tag, when sourceKind=release. */
  releaseTag?: string;
  /** Evergreen brief, when sourceKind=evergreen. */
  brief?: string;
  /** SEO/comparison context. */
  audience?: string;
  intent?: string;
  category?: string;
  angle?: string;
  slug?: string;
}

export function buildUserMessage(job: GenJob): string {
  const lines: string[] = [];
  const name = product().name;

  if (job.sourceKind === "release") {
    lines.push(
      `TASK: Announce a new ${name} release (${job.releaseTag}).`,
      `These release notes are factual and may be quoted/paraphrased — but do not add features not listed here and not in the fact base:`,
      `<release-notes>\n${job.releaseNotes ?? "(no notes)"}\n</release-notes>`,
    );
  } else if (job.sourceKind === "evergreen") {
    lines.push(
      `TASK: Write an evergreen post around this angle (the angle is a brief, not copy — write fresh copy from the fact base):`,
      `ANGLE: ${job.brief}`,
    );
  } else if (job.sourceKind === "seo") {
    lines.push(
      `TASK: Write a landing-page body for the audience "${job.audience}" whose intent is "${job.intent}".`,
      `Reframe existing fact-base facts for that audience. Do not invent capabilities. Output GitHub-flavored Markdown. The VERY FIRST line must be the title as an H1 ("# Title") — no text before it. Then 3–5 short sections, a closing call to action with the link.`,
    );
  } else if (job.sourceKind === "comparison") {
    lines.push(
      `TASK: Write a comparison page: ${name} vs the category "${job.category}".`,
      `ANGLE: ${job.angle}`,
      `CRITICAL: assert facts ONLY about ${name}. Do NOT state prices, limits, or characteristics of any competitor or named product. Output GitHub-flavored Markdown with an H1.`,
    );
  }

  const limit = socialLimit(job.channel);
  if (limit) {
    lines.push(
      `FORMAT: a single ${job.channel} post, max ${limit} characters INCLUDING the link. Plain text. End with the link on its own line.`,
    );
    if (job.channel === "reddit") {
      lines.push(
        `Reddit norms: lead with genuine value/context, not a pitch. One soft mention of ${name}. No marketing voice.`,
      );
    }
  } else if (job.channel === "changelog") {
    lines.push(
      `FORMAT: a short changelog entry in GitHub-flavored Markdown. An H2 with the version, then a 2–4 sentence human summary of what changed and why it matters to a user (translate technical notes into plain benefits). No invented items. Do NOT include any URL — the changelog page renders its own download button.`,
    );
  } else if (job.channel === "blog") {
    lines.push(
      `FORMAT: a 350–600 word blog post in GitHub-flavored Markdown. The VERY FIRST line must be the title as an H1 ("# Title") — no text before it. Then a short intro, 2–4 sections, a closing CTA with the link. Editorial and calm.`,
    );
  }

  if (job.channel === "changelog") {
    lines.push(`Do NOT include any URL in the output — the page adds its own download button.`);
  } else {
    lines.push(`THE LINK (use exactly once, verbatim): ${job.url}`);
  }
  return lines.join("\n\n");
}
