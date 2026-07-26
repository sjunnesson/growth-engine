import { product } from "@/lib/product";
import { CONTENT_CHANNELS } from "@/lib/channels";

/**
 * Builds the UTM-tagged link. A UTM-aware analytics setup on the target site
 * (e.g. Umami) records these automatically, so attribution costs zero website
 * changes. utm_content = the dedupe key, so a post seen in the wild
 * reconciles back to exactly one post_queue row and one referral.
 */
export function utmUrl(
  baseUrl: string,
  channel: string,
  sourceKind: string,
  dedupeKey: string,
): string {
  const u = new URL(baseUrl, product().siteUrl);
  u.searchParams.set("utm_source", channel);
  u.searchParams.set("utm_medium", CONTENT_CHANNELS.has(channel) ? "owned" : "social");
  u.searchParams.set("utm_campaign", sourceKind);
  u.searchParams.set("utm_content", dedupeKey);
  return u.toString();
}
