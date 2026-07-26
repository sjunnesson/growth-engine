import { sql } from "@/lib/db/client";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { SOCIAL_CHANNELS } from "@/lib/social/index";

/** Every channel gets its own kill scope; "social"/"content" are the family
 *  switches above them. */
export function scopeFor(channel: string): string {
  return `channel:${channel}`;
}

function familyOf(scope: string): string | null {
  if (!scope.startsWith("channel:")) return null;
  const ch = scope.slice("channel:".length);
  return SOCIAL_CHANNELS.includes(ch) ? "social" : "content";
}

/**
 * Returns the scope that is HALTING execution, or null if clear.
 * Precedence (any one halts): GROWTH_HALT env > global > the channel's
 * family ("social" or "content") > the channel scope itself.
 */
export async function blockedBy(scope: string): Promise<string | null> {
  // Defense in depth: env hard-stop is checked before the DB is even touched,
  // so a poisoned/over-full DB can't prevent a halt.
  if (env.growthHalt) return "env:GROWTH_HALT";

  const family = familyOf(scope);
  const checkOrder = ["global", ...(family ? [family] : []), scope];

  const rows = await sql<{ scope: string; enabled: boolean }[]>`
    SELECT scope, enabled FROM kill_switch WHERE scope = ANY(${checkOrder})
  `;
  for (const want of checkOrder) {
    const row = rows.find((r) => r.scope === want);
    if (row && row.enabled === false) return want;
  }
  return null;
}

/**
 * Guard for the top of every cron handler. If halted, writes an audit row and
 * returns true (caller must return immediately).
 */
export async function abortIfKilled(
  actor: string,
  scope: string,
): Promise<boolean> {
  const by = await blockedBy(scope);
  if (by) {
    await audit(actor, "killswitch_abort", { scope, blockedBy: by }, { level: "warn" });
    return true;
  }
  return false;
}

export async function setKill(
  scope: string,
  enabled: boolean,
  reason: string,
): Promise<void> {
  await sql`
    INSERT INTO kill_switch (scope, enabled, reason, updated_at)
    VALUES (${scope}, ${enabled}, ${reason}, now())
    ON CONFLICT (scope)
    DO UPDATE SET enabled = ${enabled}, reason = ${reason}, updated_at = now()
  `;
}

export async function listKill() {
  return sql<{ scope: string; enabled: boolean; reason: string | null; updated_at: Date }[]>`
    SELECT scope, enabled, reason, updated_at FROM kill_switch ORDER BY scope
  `;
}
