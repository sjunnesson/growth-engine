import { postMastodon } from "@/lib/social/mastodon";
import { postBluesky } from "@/lib/social/bluesky";
import { postLinkedIn } from "@/lib/social/linkedin";
import { postReddit } from "@/lib/social/reddit";
import { postX } from "@/lib/social/x";

export interface PublishResult {
  externalId: string;
  url?: string;
}

/** Uniform client signature. Each throws on failure. */
export type SocialClient = (
  text: string,
  ctx: { subreddit?: string; title?: string },
) => Promise<PublishResult>;

const CLIENTS: Record<string, SocialClient> = {
  mastodon: postMastodon,
  bluesky: postBluesky,
  linkedin: postLinkedIn,
  reddit: postReddit,
  x: postX,
};

export const SOCIAL_CHANNELS = Object.keys(CLIENTS);

export function getClient(channel: string): SocialClient {
  const c = CLIENTS[channel];
  if (!c) throw new Error(`unknown social channel: ${channel}`);
  return c;
}
