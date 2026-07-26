import { assertAdmin, json } from "@/lib/http";
import { setKill, listKill } from "@/lib/killswitch";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// POST { scope, enabled, reason }  — flip a kill switch.
// scope: global | content | social | channel:<mastodon|bluesky|...>
export async function POST(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;

  let body: { scope?: string; enabled?: boolean; reason?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.scope || typeof body.enabled !== "boolean")
    return json({ error: "scope (string) and enabled (boolean) required" }, 400);

  await setKill(body.scope, body.enabled, body.reason ?? "via admin");
  await audit("admin", body.enabled ? "skip" : "killswitch_abort", {
    action: "set_kill_switch",
    scope: body.scope,
    enabled: body.enabled,
    reason: body.reason,
  }, { level: "warn" });

  return json({ ok: true, switches: await listKill() });
}

export async function GET(req: Request) {
  const unauth = assertAdmin(req);
  if (unauth) return unauth;
  return json({ switches: await listKill() });
}
