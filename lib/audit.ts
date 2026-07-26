import { sql, jsonb } from "@/lib/db/client";

export type AuditAction =
  | "enqueue"
  | "generate"
  | "guardrail_pass"
  | "guardrail_block"
  | "publish"
  | "skip"
  | "killswitch_abort"
  | "rate_limited"
  | "dry_run"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "retry"
  | "reaped"
  | "angle_added"
  | "angle_removed"
  | "facts_updated"
  | "cadence_updated"
  | "product_reviewed"
  | "product_file_updated"
  | "error";

/**
 * Append-only. Never throws into the caller — an audit failure must not stop
 * the engine from refusing to publish, but it also must not crash a cron.
 */
export async function audit(
  actor: string,
  action: AuditAction,
  detail: Record<string, unknown> = {},
  opts: { queueId?: string; level?: "info" | "warn" | "error" } = {},
): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_log (actor, action, queue_id, level, detail)
      VALUES (${actor}, ${action}, ${opts.queueId ?? null},
              ${opts.level ?? (action === "error" ? "error" : "info")},
              ${jsonb(detail)})
    `;
  } catch (err) {
    // Last resort: log to stdout (captured by Vercel) so we never lose the trail.
    console.error("[audit] insert failed", action, err, detail);
  }
}
