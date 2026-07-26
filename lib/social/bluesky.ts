import { env } from "@/lib/env";
import type { PublishResult } from "@/lib/social/index";

const PDS = "https://bsky.social";

// AT Protocol: createSession -> createRecord. Hand-rolled, no SDK.
export async function postBluesky(text: string): Promise<PublishResult> {
  const { identifier, appPassword } = env.bluesky;
  if (!identifier || !appPassword) throw new Error("bluesky not configured");

  const sess = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password: appPassword }),
  });
  if (!sess.ok) throw new Error(`bluesky session ${sess.status}`);
  const { accessJwt, did } = (await sess.json()) as {
    accessJwt: string;
    did: string;
  };

  const rec = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date().toISOString(),
        facets: linkFacets(text),
      },
    }),
  });
  if (!rec.ok) throw new Error(`bluesky post ${rec.status}: ${await rec.text()}`);
  const { uri } = (await rec.json()) as { uri: string };
  const rkey = uri.split("/").pop();
  return {
    externalId: uri,
    url: `https://bsky.app/profile/${identifier}/post/${rkey}`,
  };
}

// Make the (single) link clickable via a byte-range facet.
function linkFacets(text: string) {
  const m = text.match(/https?:\/\/[^\s)]+/);
  if (!m || m.index === undefined) return [];
  const enc = new TextEncoder();
  const start = enc.encode(text.slice(0, m.index)).length;
  const end = start + enc.encode(m[0]).length;
  return [
    {
      index: { byteStart: start, byteEnd: end },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    },
  ];
}
