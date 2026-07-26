import type { PublishResult } from "@/lib/social/index";

// X / Twitter write access requires a PAID API tier (~$100/mo+). The client is
// kept code-complete behind the uniform interface but is HARD-DISABLED: it
// always throws so it can never publish until the paid tier is a deliberate
// decision. To enable: implement the OAuth1.0a/2.0 POST to /2/tweets here and
// remove the throw, then add "x" to LIVE_CHANNELS.
export async function postX(_text: string): Promise<PublishResult> {
  throw new Error(
    "x channel is disabled (paid API tier required — deliberate opt-in only)",
  );
}
