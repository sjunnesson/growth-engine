import { env } from "@/lib/env";
import { product } from "@/lib/product";
import type { PublishResult } from "@/lib/social/index";

// Hand-rolled client — single authenticated POST. No SDK, no SaaS.
export async function postMastodon(text: string): Promise<PublishResult> {
  const { baseUrl, token } = env.mastodon;
  if (!baseUrl || !token) throw new Error("mastodon not configured");

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/statuses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": cryptoKey(text),
    },
    body: JSON.stringify({ status: text, visibility: "public" }),
  });
  if (!res.ok)
    throw new Error(`mastodon ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { id: string; url: string };
  return { externalId: json.id, url: json.url };
}

// Mastodon honours Idempotency-Key — extra belt to the DB dedupe braces.
function cryptoKey(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${product().slug}-${h >>> 0}`;
}
