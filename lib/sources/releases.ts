import { octokit, splitRepo } from "@/lib/github/octokit";
import { product } from "@/lib/product";

export interface ReleaseInfo {
  tag: string; // e.g. v0.4.0
  name: string;
  body: string; // release notes (verbatim, treated as factual)
  publishedAt: string;
  url: string;
  /** True when the tag parsed as vX.Y.Z. Non-semver tags (CalVer, "v1.2",
   *  date tags) get semver=false instead of a bogus 0.0.0. */
  semver: boolean;
  major: number;
  minor: number;
  patch: number;
}

function parseTag(tag: string) {
  const m = tag.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { semver: false, major: 0, minor: 0, patch: 0 };
  return { semver: true, major: +m[1], minor: +m[2], patch: +m[3] };
}

/** Most recent releases, newest first. GitHub Releases is the only source
 *  implemented today; a repo without Releases has no release feed (the drip
 *  and SEO/comparison channels still run). */
export async function listReleases(limit = 20): Promise<ReleaseInfo[]> {
  const { owner, repo } = splitRepo(product().github.releasesRepo);
  const { data } = await octokit().repos.listReleases({
    owner,
    repo,
    per_page: limit,
  });
  return data
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body || "",
      publishedAt: r.published_at || r.created_at,
      url: r.html_url,
      ...parseTag(r.tag_name),
    }));
}

/**
 * Which releases deserve a social post. Behavior depends on the product's
 * tag scheme:
 *
 * "semver" — patch-release collapse for high-frequency shippers: a release is
 * social-worthy only if it's a minor/major bump (patch === 0), OR it's the
 * newest release and >= rollupPatchCount patches accumulated since the last
 * minor (one "rollup" post for the newest patch). A non-semver tag inside a
 * semver scheme is treated as announce-worthy (it's exceptional by
 * definition).
 *
 * "any" — every release is social-worthy. For products that tag rarely and
 * irregularly; the enqueuer's max-age window and the per-channel rate caps
 * still bound the volume.
 *
 * content-sync records EVERY release in the changelog regardless; this only
 * governs what becomes a social post.
 */
export function socialWorthy(
  releases: ReleaseInfo[],
): { release: ReleaseInfo; reason: string }[] {
  const cfg = product().releases;
  const sorted = [...releases].sort(
    (a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt),
  );

  if (cfg.tagScheme === "any") {
    return sorted.map((r) => ({ release: r, reason: `release ${r.tag}` }));
  }

  const out: { release: ReleaseInfo; reason: string }[] = [];
  for (const r of sorted) {
    if (!r.semver) {
      out.push({ release: r, reason: `non-semver tag ${r.tag}` });
    } else if (r.patch === 0) {
      out.push({ release: r, reason: `minor/major bump ${r.tag}` });
    }
  }
  // Rollup rule: if the newest release is a patch and >= rollupPatchCount
  // patches since the last minor/major, post a single rollup for the newest.
  if (sorted[0] && sorted[0].semver && sorted[0].patch !== 0) {
    let count = 0;
    for (const r of sorted) {
      if (!r.semver || r.patch === 0) break;
      count++;
    }
    if (count >= cfg.rollupPatchCount)
      out.unshift({
        release: sorted[0],
        reason: `patch rollup (${count} patches since last minor)`,
      });
  }
  return out;
}
