import { CONTENT_CHANNELS as MARKDOWN_CHANNELS } from "@/lib/channels";

/**
 * Deterministic output hygiene for markdown content channels. Models
 * occasionally narrate ("Writing a blog post on...") and/or wrap the real
 * copy in a ```markdown fence despite the no-preamble instruction — one such
 * post shipped rendering the narration. Runs before lint; lint then BLOCKS
 * anything that still doesn't start with a heading.
 */
export function normalizeMarkdown(channel: string, text: string): string {
  let t = text.trim();
  if (!MARKDOWN_CHANNELS.has(channel)) return t;

  // Whole output wrapped in a single fence (optionally preceded by a short
  // preamble): unwrap when the fence holds the actual headed document.
  const fence = t.match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence && fence.index !== undefined && /^#{1,2} /m.test(fence[1])) {
    const before = t.slice(0, fence.index).trim();
    if (!/^#{1,2} /m.test(before) && before.split("\n").length <= 3) {
      t = fence[1].trim();
    }
  }

  // Short narration before the first heading: drop it. Longer prefixes are
  // left alone (could be legitimate content) — lint decides their fate.
  const h = t.search(/^#{1,2} /m);
  if (h > 0) {
    const before = t.slice(0, h).trim();
    if (before.split("\n").length <= 3) t = t.slice(h);
  }

  return t.trim();
}
