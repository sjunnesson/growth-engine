// The channel registry: ONE declaration per channel. Everything channel-shaped
// (rate caps, char limits, approval lanes, risk tier, kill-switch seeds,
// markdown rules) derives from here — adding a channel means one entry here
// plus, for social, a client in lib/social/. Platform facts (char limits) and
// safety posture (caps, approval) are engine-level, not product-level; which
// social channels a product actually targets lives in product.json.

export type ChannelKind = "social" | "content";

export interface ChannelDef {
  id: string;
  kind: ChannelKind;
  /** Hard platform character limit (social only) — enforced by lint AND
   *  stated in the generation prompt. */
  charLimit?: number;
  /** Hard autonomous-spam ceiling. Conservative on purpose: the failure mode
   *  we protect against is "post everywhere", not "post too little". */
  caps: { perDay: number; perHour: number };
  /** Human OK required in the dashboard before publishing. */
  requiresApproval: boolean;
  /** Live ONLY if EXPLICITLY listed in LIVE_CHANNELS, regardless of DRY_RUN. */
  highRisk?: boolean;
  /** Content channels: the generated markdown must open with this heading. */
  headingRe?: RegExp;
}

export const CHANNELS: Record<string, ChannelDef> = {
  // Social: public + irreversible => always approval-gated.
  mastodon: { id: "mastodon", kind: "social", charLimit: 500, caps: { perDay: 3, perHour: 1 }, requiresApproval: true },
  bluesky: { id: "bluesky", kind: "social", charLimit: 300, caps: { perDay: 3, perHour: 1 }, requiresApproval: true },
  linkedin: { id: "linkedin", kind: "social", charLimit: 1300, caps: { perDay: 2, perHour: 1 }, requiresApproval: true },
  // Reddit: strongest anti-promo norms of any platform => high risk.
  reddit: { id: "reddit", kind: "social", charLimit: 1500, caps: { perDay: 1, perHour: 1 }, requiresApproval: true, highRisk: true },
  x: { id: "x", kind: "social", charLimit: 280, caps: { perDay: 2, perHour: 1 }, requiresApproval: true },

  // Content: committed into the website repo => git-revertable. Only changelog
  // auto-publishes (release-notes-derived); blog/seo wait for editorial OK.
  changelog: { id: "changelog", kind: "content", caps: { perDay: 10, perHour: 6 }, requiresApproval: false, headingRe: /^#{1,2} / },
  // Blog day cap sized so a same-day regeneration sweep (replacement commits
  // to existing slugs) fits alongside the organic drip post.
  blog: { id: "blog", kind: "content", caps: { perDay: 8, perHour: 2 }, requiresApproval: true, headingRe: /^# / },
  seo: { id: "seo", kind: "content", caps: { perDay: 6, perHour: 3 }, requiresApproval: true, headingRe: /^# / },
  // Comparison pages: highest-risk content (adjacent to competitor claims).
  comparison: { id: "comparison", kind: "content", caps: { perDay: 2, perHour: 1 }, requiresApproval: true, highRisk: true, headingRe: /^# / },
};

const all = Object.values(CHANNELS);

export const SOCIAL_CHANNELS = all.filter((c) => c.kind === "social").map((c) => c.id);
export const CONTENT_CHANNELS = new Set(all.filter((c) => c.kind === "content").map((c) => c.id));
export const APPROVAL_CHANNELS = new Set(all.filter((c) => c.requiresApproval).map((c) => c.id));
export const HIGH_RISK_CHANNELS = new Set(all.filter((c) => c.highRisk).map((c) => c.id));

export function channelDef(id: string): ChannelDef | undefined {
  return CHANNELS[id];
}

/** Social char limit, or undefined for content channels / unknown ids. */
export function socialLimit(id: string): number | undefined {
  return CHANNELS[id]?.charLimit;
}

/** Rate caps with a conservative default for unknown channels. */
export function channelCaps(id: string): { perDay: number; perHour: number } {
  return CHANNELS[id]?.caps ?? { perDay: 2, perHour: 1 };
}

/** Kill-switch scopes migrate.ts seeds so every channel gets a dashboard
 *  toggle. Hierarchy: global > family (content|social) > channel. */
export function killSwitchScopes(): string[] {
  return ["global", "content", "social", ...all.map((c) => `channel:${c.id}`)];
}
