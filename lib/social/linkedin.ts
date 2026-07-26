import { env } from "@/lib/env";
import type { PublishResult } from "@/lib/social/index";

// Phase 3. LinkedIn UGC Posts API. Token + author URN provisioned out of band
// (OAuth onboarding friction is why this is later in the rollout).
export async function postLinkedIn(text: string): Promise<PublishResult> {
  const { token, authorUrn } = env.linkedin;
  if (!token || !authorUrn) throw new Error("linkedin not configured");

  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  if (!res.ok) throw new Error(`linkedin ${res.status}: ${await res.text()}`);
  const id = res.headers.get("x-restli-id") || "";
  return { externalId: id };
}
