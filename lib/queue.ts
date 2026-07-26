// Read + action helpers for the local dashboard. Mutations are guarded so a
// stale page can't, e.g., approve an item that already published.
import { sql } from "@/lib/db/client";
import type { QueueRow } from "@/lib/db/client";
import { audit } from "@/lib/audit";

const ACTOR = "dashboard";

export async function awaitingApproval(): Promise<QueueRow[]> {
  return [
    ...(await sql<QueueRow[]>`
      SELECT * FROM post_queue WHERE status = 'ready'
      ORDER BY created_at ASC`),
  ];
}

export async function recentItems(limit = 40): Promise<QueueRow[]> {
  return [
    ...(await sql<QueueRow[]>`
      SELECT * FROM post_queue
      WHERE status <> 'ready'
      ORDER BY updated_at DESC
      LIMIT ${limit}`),
  ];
}

export async function getItem(id: string): Promise<QueueRow | null> {
  const [r] = await sql<QueueRow[]>`SELECT * FROM post_queue WHERE id = ${id}`;
  return r ?? null;
}

export async function statusCounts(): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; n: number }[]>`
    SELECT status, count(*)::int AS n FROM post_queue GROUP BY status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export interface AuditRow {
  ts: Date;
  actor: string;
  action: string;
  level: string;
  queue_id: string | null;
  detail: Record<string, unknown>;
}

export async function recentAudit(limit = 60): Promise<AuditRow[]> {
  return [
    ...(await sql<AuditRow[]>`
      SELECT ts, actor, action, level, queue_id, detail
      FROM audit_log ORDER BY ts DESC LIMIT ${limit}`),
  ];
}

/**
 * Approve a 'ready' row. Optionally replace the copy first (operator edit).
 * Guarded: only acts while the row is still 'ready'. The actual publish (and a
 * final deterministic lint of the possibly-edited text) happens in the next
 * runner tick via publishApprovedRow — so a bad manual edit is still blocked.
 */
export async function approveItem(
  id: string,
  editedText?: string,
): Promise<{ ok: boolean; message: string }> {
  const clean = editedText?.trim();
  const rows = await sql<{ id: string }[]>`
    UPDATE post_queue SET
      status = 'approved',
      generated_text = COALESCE(${clean && clean.length ? clean : null}, generated_text),
      scheduled_for = now(),
      updated_at = now()
    WHERE id = ${id} AND status = 'ready'
    RETURNING id`;
  if (!rows.length)
    return { ok: false, message: "Item is no longer awaiting approval." };
  await audit(ACTOR, "approved", { edited: Boolean(clean && clean.length) }, { queueId: id });
  return { ok: true, message: "Approved — it will publish on the next tick." };
}

export async function rejectItem(
  id: string,
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE post_queue SET status = 'skipped',
      last_error = ${reason ?? "rejected via dashboard"},
      updated_at = now()
    WHERE id = ${id} AND status = 'ready'
    RETURNING id`;
  if (!rows.length)
    return { ok: false, message: "Item is no longer awaiting approval." };
  await audit(ACTOR, "rejected", { reason: reason ?? null }, { queueId: id, level: "warn" });
  return { ok: true, message: "Rejected — it will not be published." };
}

/**
 * Re-queue an item from scratch (regenerates next tick). Includes dry_run:
 * that status is terminal, so after a channel goes live this is how the
 * operator promotes content that was processed during the dry-run phase.
 */
export async function retryItem(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE post_queue SET status = 'pending', scheduled_for = now(),
      last_error = null, updated_at = now()
    WHERE id = ${id} AND status IN ('failed', 'skipped', 'dry_run')
    RETURNING id`;
  if (!rows.length)
    return { ok: false, message: "Only failed, skipped, or dry-run items can be retried." };
  await audit(ACTOR, "retry", {}, { queueId: id });
  return { ok: true, message: "Re-queued." };
}
