// Read-model for the Cadence page: when posts actually went out per channel,
// how much of today's cap budget is consumed, and what is due to go out next.
// Publish time == updated_at of a 'published' row ('published' is terminal, so
// updated_at never moves after the publish tick).
import { sql } from "@/lib/db/client";
import type { QueueRow } from "@/lib/db/client";
import { caps, dayKey, hourKey } from "@/lib/ratelimit";
import { product } from "@/lib/product";
import { SOCIAL_CHANNELS, CONTENT_CHANNELS as CONTENT_SET } from "@/lib/channels";
import {
  evergreenKey,
  contentKey,
  rotationIndex,
  periodStartAhead,
} from "@/lib/dedupe";
import { getCadenceSettings } from "@/lib/settings";
import {
  loadEvergreen,
  loadSeoPages,
  loadComparisons,
} from "@/lib/sources/factbase";

const CONTENT_CHANNELS = [...CONTENT_SET];
// Display order: targeted social first, dormant social, then content.
function channelOrder(): string[] {
  const targets = product().socialTargets;
  return [
    ...targets,
    ...SOCIAL_CHANNELS.filter((c) => !targets.includes(c)),
    ...CONTENT_CHANNELS,
  ];
}

export interface ChannelCadence {
  channel: string;
  lastPublishedAt: Date | null;
  last24h: number;
  last7d: number;
  last30d: number;
  usedToday: number;
  usedThisHour: number;
  capPerDay: number;
  capPerHour: number;
}

/** One row per channel that is either actively targeted or has ever published. */
export async function channelCadence(): Promise<ChannelCadence[]> {
  const pub = await sql<
    {
      channel: string;
      last_published_at: Date;
      last_24h: number;
      last_7d: number;
      last_30d: number;
    }[]
  >`
    SELECT channel,
           max(updated_at) AS last_published_at,
           count(*) FILTER (WHERE updated_at > now() - interval '24 hours')::int AS last_24h,
           count(*) FILTER (WHERE updated_at > now() - interval '7 days')::int  AS last_7d,
           count(*) FILTER (WHERE updated_at > now() - interval '30 days')::int AS last_30d
    FROM post_queue
    WHERE status = 'published'
    GROUP BY channel`;
  const byChannel = new Map(pub.map((r) => [r.channel, r]));

  const order = channelOrder();
  const targets = product().socialTargets;
  const channels = [
    ...order.filter(
      (c) =>
        byChannel.has(c) ||
        targets.includes(c) ||
        CONTENT_CHANNELS.includes(c),
    ),
    ...pub.map((r) => r.channel).filter((c) => !order.includes(c)),
  ];

  // Cap usage comes from the same buckets tryConsume() checks, so the numbers
  // shown are exactly the budget the publisher sees (UTC windows).
  const buckets = channels.flatMap((c) => [
    `${c}:day:${dayKey()}`,
    `${c}:hour:${hourKey()}`,
  ]);
  const rl = await sql<{ bucket: string; count: number }[]>`
    SELECT bucket, count FROM rate_limit WHERE bucket = ANY(${buckets})`;
  const used = new Map(rl.map((r) => [r.bucket, r.count]));

  return channels.map((channel) => {
    const p = byChannel.get(channel);
    const c = caps(channel);
    return {
      channel,
      lastPublishedAt: p?.last_published_at ?? null,
      last24h: p?.last_24h ?? 0,
      last7d: p?.last_7d ?? 0,
      last30d: p?.last_30d ?? 0,
      usedToday: used.get(`${channel}:day:${dayKey()}`) ?? 0,
      usedThisHour: used.get(`${channel}:hour:${hourKey()}`) ?? 0,
      capPerDay: c.perDay,
      capPerHour: c.perHour,
    };
  });
}

/** Publishes per channel per UTC day (matches the cap windows). */
export async function publishHistogram(
  days: number,
): Promise<Map<string, number>> {
  const rows = await sql<{ channel: string; day: string; n: number }[]>`
    SELECT channel,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           count(*)::int AS n
    FROM post_queue
    WHERE status = 'published'
      AND updated_at > now() - make_interval(days => ${days})
    GROUP BY channel, day`;
  return new Map(rows.map((r) => [`${r.channel}:${r.day}`, r.n]));
}

/** Rows that will go out (or are waiting on the operator), soonest first. */
export async function upcomingItems(limit = 15): Promise<QueueRow[]> {
  return [
    ...(await sql<QueueRow[]>`
      SELECT * FROM post_queue
      WHERE status IN ('pending', 'approved', 'ready')
      ORDER BY (status = 'ready') ASC, scheduled_for ASC
      LIMIT ${limit}`),
  ];
}

export interface PlannedNext {
  kind: "tick" | "time" | "approval" | "release" | "none";
  when: Date | null; // set for kind 'time'
  what: string; // short description of the post; "" when there is none
}

/**
 * When the next post is planned per channel. A concrete queue row wins;
 * otherwise the enqueuers are forecast with the same angle rotation, drip
 * intervals, and dedupe keys they use, so "planned" is exactly what the
 * coming ticks will enqueue.
 */
export async function nextPlanned(
  channels: string[],
): Promise<Map<string, PlannedNext>> {
  const out = new Map<string, PlannedNext>();

  const queued = await sql<
    {
      channel: string;
      status: string;
      source_kind: string;
      scheduled_for: Date;
    }[]
  >`
    SELECT DISTINCT ON (channel) channel, status, source_kind, scheduled_for
    FROM post_queue
    WHERE status IN ('pending', 'approved', 'ready')
    ORDER BY channel, (status = 'ready') ASC, scheduled_for ASC`;
  for (const q of queued) {
    const what = `queued ${q.source_kind}`;
    if (q.status === "ready") out.set(q.channel, { kind: "approval", when: null, what });
    else if (+new Date(q.scheduled_for) <= Date.now())
      out.set(q.channel, { kind: "tick", when: null, what });
    else out.set(q.channel, { kind: "time", when: q.scheduled_for, what });
  }

  const { socialIntervalDays, blogIntervalDays } = await getCadenceSettings();
  const angles = loadEvergreen();
  const angleAt = (d: Date, intervalDays: number) =>
    angles[rotationIndex(d, intervalDays) % angles.length];

  // Ordered soonest-first per channel; the first candidate whose dedupe key
  // does not exist yet is the next planned enqueue.
  const candidates: { channel: string; key: string; plan: PlannedNext }[] = [];

  for (const ch of product().socialTargets) {
    if (out.has(ch)) continue;
    const nowAngle = angleAt(new Date(), socialIntervalDays);
    candidates.push({
      channel: ch,
      key: evergreenKey(nowAngle.id, ch, new Date(), socialIntervalDays),
      plan: { kind: "tick", when: null, what: `evergreen "${nowAngle.id}"` },
    });
    const nextPeriod = periodStartAhead(new Date(), socialIntervalDays);
    const nextAngle = angleAt(nextPeriod, socialIntervalDays);
    candidates.push({
      channel: ch,
      key: evergreenKey(nextAngle.id, ch, nextPeriod, socialIntervalDays),
      plan: { kind: "time", when: nextPeriod, what: `evergreen "${nextAngle.id}"` },
    });
  }

  // Blog slugs are angle ids (one post per angle, ever) — the next planned
  // post is the first coming drip period whose rotated angle has no post yet.
  if (!out.has("blog")) {
    for (let w = 0; w < angles.length; w++) {
      const d =
        w === 0 ? new Date() : periodStartAhead(new Date(), blogIntervalDays, w);
      const a = angleAt(d, blogIntervalDays);
      candidates.push({
        channel: "blog",
        key: contentKey("blog", a.id),
        plan:
          w === 0
            ? { kind: "tick", when: null, what: `blog "${a.id}"` }
            : { kind: "time", when: d, what: `blog "${a.id}"` },
      });
    }
  }
  if (!out.has("seo")) {
    for (const s of loadSeoPages()) {
      candidates.push({
        channel: "seo",
        key: contentKey("seo", s.slug),
        plan: { kind: "tick", when: null, what: `page "${s.slug}"` },
      });
    }
  }
  if (!out.has("comparison")) {
    for (const c of loadComparisons()) {
      candidates.push({
        channel: "comparison",
        key: contentKey("comparison", c.slug),
        plan: { kind: "tick", when: null, what: `page "${c.slug}"` },
      });
    }
  }

  const keys = candidates.map((c) => c.key);
  const existing = new Set(
    keys.length
      ? (
          await sql<{ dedupe_key: string }[]>`
            SELECT dedupe_key FROM post_queue WHERE dedupe_key = ANY(${keys})`
        ).map((r) => r.dedupe_key)
      : [],
  );
  for (const c of candidates) {
    if (out.has(c.channel) || existing.has(c.key)) continue;
    out.set(c.channel, c.plan);
  }

  if (!out.has("changelog"))
    out.set("changelog", { kind: "release", when: null, what: "" });
  for (const ch of channels)
    if (!out.has(ch)) out.set(ch, { kind: "none", when: null, what: "" });

  return out;
}

/** The actual outbound timeline, newest first. */
export async function recentPublishes(limit = 20): Promise<QueueRow[]> {
  return [
    ...(await sql<QueueRow[]>`
      SELECT * FROM post_queue
      WHERE status = 'published'
      ORDER BY updated_at DESC
      LIMIT ${limit}`),
  ];
}
