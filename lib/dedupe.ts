import { sql, jsonb } from "@/lib/db/client";
import type { QueueRow } from "@/lib/db/client";
import { audit } from "@/lib/audit";

/**
 * Deterministic dedupe keys. Same logical post → same key → UNIQUE constraint
 * makes a retried/concurrent enqueue a no-op.
 *
 *  release:<tag>:<channel>            one post per release per channel
 *  evergreen:<angleId>:<YYYY-WW>:<ch> one evergreen angle per ISO week per ch
 *  content:<kind>:<slug>              one content file per slug
 */
export function releaseKey(tag: string, channel: string) {
  return `release:${tag}:${channel}`;
}
export function evergreenKey(
  angleId: string,
  channel: string,
  d = new Date(),
  intervalDays = 7,
) {
  return `evergreen:${angleId}:${periodKeyPart(d, intervalDays)}:${channel}`;
}
export function contentKey(kind: string, slug: string) {
  return `content:${kind}:${slug}`;
}

export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((+date - +yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Integer that advances once per ISO week. Rotation indexes must use THIS
 * (not epoch-week math) so the week that picks an angle and the week in its
 * dedupe key roll over on the same boundary — otherwise an angle chosen late
 * in one ISO week is re-enqueued when the other definition ticks first.
 */
export function isoWeekIndex(d = new Date()): number {
  const [y, w] = isoWeek(d).split("-W");
  return +y * 54 + +w;
}

/**
 * Generalized drip period for the operator-configurable cadence
 * (lib/settings.ts). Anchored to Monday 1970-01-05 so a 7-day interval rolls
 * over on the same Monday boundary as the ISO-week scheme. The same rule as
 * isoWeekIndex applies: the period that picks an angle and the period in its
 * dedupe key must both come from here so they roll over together.
 */
const PERIOD_ANCHOR_UTC_DAY = 4; // days from epoch to Monday 1970-01-05

function utcDayOf(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
}

export function periodIndex(d: Date, intervalDays: number): number {
  return Math.floor((utcDayOf(d) - PERIOD_ANCHOR_UTC_DAY) / intervalDays);
}

/** Key fragment for one drip period. The 7-day form stays byte-identical to
 *  the original ISO-week keys so the default cadence never re-enqueues rows
 *  that predate configurable frequency. */
export function periodKeyPart(d: Date, intervalDays: number): string {
  if (intervalDays === 7) return isoWeek(d);
  return `p${intervalDays}d-${periodIndex(d, intervalDays)}`;
}

/** Rotation counter that advances once per drip period (same boundary as
 *  periodKeyPart, per the rule above). */
export function rotationIndex(d: Date, intervalDays: number): number {
  return intervalDays === 7 ? isoWeekIndex(d) : periodIndex(d, intervalDays);
}

/** Local-midnight start of the period `periodsAhead` after the one containing d. */
export function periodStartAhead(
  d: Date,
  intervalDays: number,
  periodsAhead = 1,
): Date {
  if (intervalDays === 7) {
    const n = new Date(d);
    n.setHours(0, 0, 0, 0);
    const dow = n.getDay() || 7;
    n.setDate(n.getDate() + (8 - dow) + (periodsAhead - 1) * 7);
    return n;
  }
  const startUtcDay =
    (periodIndex(d, intervalDays) + periodsAhead) * intervalDays +
    PERIOD_ANCHOR_UTC_DAY;
  const u = new Date(startUtcDay * 864e5);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

export interface EnqueueInput {
  channel: string;
  sourceKind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  scheduledFor?: Date;
}

/** Idempotent enqueue. Returns the row id, or null if it already existed. */
export async function enqueue(
  actor: string,
  input: EnqueueInput,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO post_queue (channel, source_kind, dedupe_key, payload_in, scheduled_for)
    VALUES (${input.channel}, ${input.sourceKind}, ${input.dedupeKey},
            ${jsonb(input.payload)}, ${input.scheduledFor ?? new Date()})
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `;
  const id = rows[0]?.id ?? null;
  if (id) {
    await audit(actor, "enqueue", { ...input }, { queueId: id });
  }
  return id;
}

/**
 * Atomically claim up to `limit` due, pending rows for processing.
 * The conditional UPDATE ... WHERE status='pending' is the optimistic lock:
 * two concurrent dispatch invocations can never claim the same row.
 */
export async function claimDue(limit: number): Promise<QueueRow[]> {
  return sql<QueueRow[]>`
    UPDATE post_queue SET status = 'generating', updated_at = now()
    WHERE id IN (
      SELECT id FROM post_queue
      WHERE status = 'pending' AND scheduled_for <= now()
      ORDER BY scheduled_for ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
}

export async function setStatus(
  id: string,
  status: QueueRow["status"],
  patch: Partial<
    Pick<QueueRow, "generated_text" | "generated_meta" | "external_id" | "utm" | "last_error">
  > = {},
): Promise<void> {
  await sql`
    UPDATE post_queue SET
      status = ${status},
      generated_text = COALESCE(${patch.generated_text ?? null}, generated_text),
      generated_meta = COALESCE(${patch.generated_meta ? jsonb(patch.generated_meta) : null}, generated_meta),
      external_id = COALESCE(${patch.external_id ?? null}, external_id),
      utm = COALESCE(${patch.utm ?? null}, utm),
      last_error = ${patch.last_error ?? null},
      attempts = attempts + ${status === "failed" ? 1 : 0},
      updated_at = now()
    WHERE id = ${id}
  `;
}

/** Requeue for the next window (rate-limited items). The optional patch
 *  persists already-vetted copy so the retry republishes it instead of
 *  paying for a fresh generation each window. */
export async function requeue(
  id: string,
  when: Date,
  patch: Partial<Pick<QueueRow, "generated_text" | "generated_meta" | "utm">> = {},
): Promise<void> {
  await sql`
    UPDATE post_queue
    SET status = 'pending', scheduled_for = ${when},
        generated_text = COALESCE(${patch.generated_text ?? null}, generated_text),
        generated_meta = COALESCE(${patch.generated_meta ? jsonb(patch.generated_meta) : null}, generated_meta),
        utm = COALESCE(${patch.utm ?? null}, utm),
        updated_at = now()
    WHERE id = ${id}
  `;
}

/**
 * Claim human-approved rows for publishing. Same optimistic-lock pattern as
 * claimDue, but for the approval lane (status='approved' → 'publishing').
 */
export async function claimApproved(limit: number): Promise<QueueRow[]> {
  return sql<QueueRow[]>`
    UPDATE post_queue SET status = 'publishing', updated_at = now()
    WHERE id IN (
      SELECT id FROM post_queue
      WHERE status = 'approved' AND scheduled_for <= now()
      ORDER BY scheduled_for ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
}

/** Rate-limited approved item: keep it in the approval lane, just defer. */
export async function deferApproved(id: string, when: Date): Promise<void> {
  await sql`
    UPDATE post_queue
    SET status = 'approved', scheduled_for = ${when}, updated_at = now()
    WHERE id = ${id}
  `;
}

/**
 * Requeue after an unhandled error, counting the attempt — the runner fails a
 * row for good past MAX_ATTEMPTS so a poison payload can't retry (and pay for
 * a generation) every tick forever.
 */
export async function requeueAttempt(
  id: string,
  when: Date,
  error: string,
  lane: "auto" | "approved",
): Promise<void> {
  await sql`
    UPDATE post_queue
    SET status = ${lane === "approved" ? "approved" : "pending"},
        scheduled_for = ${when},
        attempts = attempts + 1,
        last_error = ${error},
        updated_at = now()
    WHERE id = ${id}
  `;
}

/**
 * Reclaim rows stranded mid-flight by a killed tick (sleep, reboot, SIGKILL):
 * 'generating' goes back to 'pending' (regenerate), 'publishing' back to
 * 'approved' (re-lint + republish). A row reaped from 'publishing' may have
 * reached the platform just before the crash — Mastodon dedupes via
 * Idempotency-Key and content commits skip identical files, so the worst case
 * is a rare double Bluesky post; the 'reaped' warn audit makes it visible.
 */
export async function reapStuck(maxAgeMinutes: number): Promise<QueueRow[]> {
  return sql<QueueRow[]>`
    UPDATE post_queue SET
      status = CASE WHEN status = 'generating' THEN 'pending' ELSE 'approved' END,
      attempts = attempts + 1,
      updated_at = now()
    WHERE status IN ('generating', 'publishing')
      AND updated_at < now() - make_interval(mins => ${maxAgeMinutes})
    RETURNING *
  `;
}
