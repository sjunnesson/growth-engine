import {
  enqueue,
  releaseKey,
  evergreenKey,
  contentKey,
  rotationIndex,
} from "@/lib/dedupe";
import { getCadenceSettings } from "@/lib/settings";
import { listReleases, socialWorthy } from "@/lib/sources/releases";
import { product } from "@/lib/product";
import {
  loadEvergreen,
  loadSeoPages,
  loadComparisons,
} from "@/lib/sources/factbase";

// Which social channels the engine targets right now lives in product.json
// (socialTargets) — phased rollout stays explicit + reviewable. Items still
// go through dry-run until the channel is in LIVE_CHANNELS — enqueuing !=
// publishing.
function socialTargets(): string[] {
  return product().socialTargets;
}

/** poll-releases: changelog item per new release + collapsed social items. */
export async function enqueueReleases(actor: string): Promise<number> {
  const cfg = product();
  const releases = await listReleases(15);
  let n = 0;

  // Every release -> a changelog content item (full history, low risk).
  for (const r of releases) {
    const slug = r.tag.replace(/^v/, "");
    const id = await enqueue(actor, {
      channel: "changelog",
      sourceKind: "release",
      dedupeKey: contentKey("changelog", slug),
      payload: {
        sourceKind: "release",
        linkPath: cfg.cta.release,
        releaseTag: r.tag,
        releaseName: r.name,
        releaseNotes: r.body,
        publishedAt: r.publishedAt,
        title: `${cfg.name} ${r.tag}`,
      },
    });
    if (id) n++;
  }

  // Only social-worthy releases (patch-collapsed) -> social items. Never
  // socially announce stale news: on a backfill (fresh GITHUB_TOKEN, or the
  // engine catching up after downtime) old releases are still recorded in the
  // changelog, but a social post drafted weeks late is noise to reject.
  const maxAgeMs = cfg.releases.socialMaxAgeDays * 864e5;
  for (const { release: r } of socialWorthy(releases)) {
    if (+new Date(r.publishedAt) < Date.now() - maxAgeMs) continue;
    for (const ch of socialTargets()) {
      const id = await enqueue(actor, {
        channel: ch,
        sourceKind: "release",
        dedupeKey: releaseKey(r.tag, ch),
        payload: {
          sourceKind: "release",
          linkPath: cfg.cta.release,
          releaseTag: r.tag,
          releaseName: r.name,
          releaseNotes: r.body,
        },
      });
      if (id) n++;
    }
  }
  return n;
}

/** social-drip: rotate one evergreen angle per channel, once per drip period
 *  (default weekly; operator-tunable in the dashboard → settings table). */
export async function enqueueEvergreenSocial(actor: string): Promise<number> {
  const { socialIntervalDays } = await getCadenceSettings();
  const angles = loadEvergreen();
  // Deterministic rotation so the angle differs period to period. Rotation
  // index and dedupe key must share the same period definition (dedupe.ts).
  const angle = angles[rotationIndex(new Date(), socialIntervalDays) % angles.length];
  let n = 0;
  for (const ch of socialTargets()) {
    const id = await enqueue(actor, {
      channel: ch,
      sourceKind: "evergreen",
      dedupeKey: evergreenKey(angle.id, ch, new Date(), socialIntervalDays),
      payload: {
        sourceKind: "evergreen",
        linkPath: new URL(angle.cta).pathname || "/",
        angleId: angle.id,
        brief: angle.brief,
      },
    });
    if (id) n++;
  }
  return n;
}

/** content-sync: blog (from evergreen angles), SEO pages, comparisons. */
export async function enqueueContentBatch(actor: string): Promise<number> {
  const cfg = product();
  let n = 0;

  // One evergreen angle -> a blog post (periodic rotation, slug-deduped).
  const { blogIntervalDays } = await getCadenceSettings();
  const angles = loadEvergreen();
  const a = angles[rotationIndex(new Date(), blogIntervalDays) % angles.length];
  const blogSlug = `${a.id}`;
  if (
    await enqueue(actor, {
      channel: "blog",
      sourceKind: "evergreen",
      dedupeKey: contentKey("blog", blogSlug),
      payload: {
        sourceKind: "evergreen",
        linkPath: new URL(a.cta).pathname || "/",
        slug: blogSlug,
        title: titleCase(a.id),
        description: a.brief.slice(0, 150),
        brief: a.brief,
      },
    })
  )
    n++;

  // All SEO pages (idempotent by slug — first run creates, later runs no-op).
  for (const s of loadSeoPages()) {
    if (
      await enqueue(actor, {
        channel: "seo",
        sourceKind: "seo",
        dedupeKey: contentKey("seo", s.slug),
        payload: {
          sourceKind: "seo",
          linkPath: cfg.cta.seo,
          slug: s.slug,
          title: titleCase(s.slug),
          description: s.intent,
          audience: s.audience,
          intent: s.intent,
        },
      })
    )
      n++;
  }

  // Comparisons (highest risk — go through critic + extra dry-run gate).
  for (const c of loadComparisons()) {
    if (
      await enqueue(actor, {
        channel: "comparison",
        sourceKind: "comparison",
        dedupeKey: contentKey("comparison", c.slug),
        payload: {
          sourceKind: "comparison",
          linkPath: cfg.cta.comparison,
          slug: c.slug,
          title: titleCase(c.slug),
          description: `How ${cfg.name} compares to ${c.category}`,
          category: c.category,
          angle: c.angle,
        },
      })
    )
      n++;
  }
  return n;
}

export function titleCase(slug: string) {
  return slug
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
