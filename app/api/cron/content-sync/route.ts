import { assertCron, json } from "@/lib/http";
import { abortIfKilled } from "@/lib/killswitch";
import { enqueueContentBatch } from "@/lib/enqueuers";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ACTOR = "cron:content-sync";

export async function GET(req: Request) {
  const unauth = assertCron(req);
  if (unauth) return unauth;
  if (await abortIfKilled(ACTOR, "content")) return json({ aborted: "killswitch" });

  try {
    const enqueued = await enqueueContentBatch(ACTOR);
    return json({ ok: true, enqueued });
  } catch (err) {
    await audit(ACTOR, "error", { error: (err as Error).message }, { level: "error" });
    return json({ ok: false, error: (err as Error).message }, 500);
  }
}
