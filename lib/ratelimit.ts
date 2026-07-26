import { sql } from "@/lib/db/client";
import { channelCaps } from "@/lib/channels";

// Hard caps live on the channel registry (lib/channels.ts) — conservative on
// purpose: the engine is fully autonomous, so the failure mode we protect
// against is "spam everywhere", not "post too little".
export function caps(channel: string) {
  return channelCaps(channel);
}

export function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
export function hourKey(d = new Date()) {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/**
 * Returns true if the channel still has budget AND consumes one unit.
 * Returns false (and consumes nothing) if either the daily or hourly cap is
 * hit. Check + consume runs in one transaction with the bucket rows locked,
 * so two concurrent dispatchers can never both pass on the last unit.
 */
export async function tryConsume(channel: string): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const c = caps(channel);
  const windows = [
    {
      bucket: `${channel}:day:${dayKey()}`,
      cap: c.perDay,
      start: new Date(dayKey() + "T00:00:00Z"),
      reason: `daily cap ${c.perDay} reached for ${channel}`,
    },
    {
      bucket: `${channel}:hour:${hourKey()}`,
      cap: c.perHour,
      start: new Date(hourKey() + ":00:00Z"),
      reason: `hourly cap ${c.perHour} reached for ${channel}`,
    },
  ];
  const buckets = windows.map((w) => w.bucket);

  const result = await sql.begin(async (tx) => {
    for (const w of windows) {
      await tx`
        INSERT INTO rate_limit (bucket, window_start, count)
        VALUES (${w.bucket}, ${w.start}, 0)
        ON CONFLICT (bucket) DO NOTHING
      `;
    }
    const rows = await tx<{ bucket: string; count: number }[]>`
      SELECT bucket, count FROM rate_limit
      WHERE bucket = ANY(${buckets}) FOR UPDATE
    `;
    for (const w of windows) {
      const n = rows.find((r) => r.bucket === w.bucket)?.count ?? 0;
      if (n >= w.cap) return { ok: false, reason: w.reason };
    }
    await tx`UPDATE rate_limit SET count = count + 1 WHERE bucket = ANY(${buckets})`;
    return { ok: true };
  });
  return result as { ok: boolean; reason?: string };
}

/** Buckets are keyed by day/hour, so past windows are dead rows — prune. */
export async function pruneRateLimit(): Promise<void> {
  await sql`DELETE FROM rate_limit WHERE window_start < now() - interval '3 days'`;
}
