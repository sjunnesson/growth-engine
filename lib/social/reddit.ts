import { env } from "@/lib/env";
import { product } from "@/lib/product";
import type { PublishResult } from "@/lib/social/index";

// Phase 3, most conservative channel. Subreddits have strong anti-promo norms;
// the dispatcher restricts this to env.reddit.subreddits and the lowest rate
// cap, and copy is generated with the "value-first, no marketing voice" brief.
export async function postReddit(
  text: string,
  ctx: { subreddit?: string; title?: string },
): Promise<PublishResult> {
  const { clientId, clientSecret, refreshToken, userAgent } = env.reddit;
  if (!clientId || !clientSecret || !refreshToken)
    throw new Error("reddit not configured");
  const sr = ctx.subreddit || env.reddit.subreddits[0];
  if (!sr) throw new Error("reddit: no allowed subreddit configured");

  const tokRes = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!tokRes.ok) throw new Error(`reddit token ${tokRes.status}`);
  const { access_token } = (await tokRes.json()) as { access_token: string };

  const res = await fetch("https://oauth.reddit.com/api/submit", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({
      sr,
      kind: "self",
      title: (ctx.title || product().name).slice(0, 300),
      text,
      api_type: "json",
    }),
  });
  if (!res.ok) throw new Error(`reddit submit ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    json: { errors: unknown[]; data?: { url?: string; name?: string } };
  };
  if (json.json.errors?.length)
    throw new Error(`reddit error: ${JSON.stringify(json.json.errors)}`);
  return {
    externalId: json.json.data?.name || "",
    url: json.json.data?.url,
  };
}
