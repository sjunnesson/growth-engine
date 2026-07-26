import { assertAdmin, json } from "@/lib/http";
import { listKill } from "@/lib/killswitch";
import { sql } from "@/lib/db/client";
import { env } from "@/lib/env";
import { loadFacts } from "@/lib/sources/factbase";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  const [byStatus, recent, switches] = await Promise.all([
    sql<{ status: string; n: number }[]>`
      SELECT status, count(*)::int AS n FROM post_queue GROUP BY status ORDER BY status`,
    sql`SELECT ts, actor, action, level, queue_id FROM audit_log
        ORDER BY ts DESC LIMIT 25`,
    listKill(),
  ]);

  return json({
    posture: {
      growthHalt: env.growthHalt,
      dryRun: env.dryRun,
      liveChannels: [...env.liveChannels],
      factbaseVersion: loadFacts().version,
      genModel: env.genModel,
      criticModel: env.criticModel,
    },
    killSwitches: switches,
    queue: byStatus,
    recentAudit: recent,
  });
}
