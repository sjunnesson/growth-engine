/**
 * Manually enqueue one evergreen angle for a channel, jumping the drip
 * rotation — e.g. a launch announcement that shouldn't wait its turn.
 * Everything downstream is unchanged: generation, lint, critic, dry-run/live
 * posture, approval gate, rate limits.
 *
 *   npm run seed -- blog iphone-share-sheet
 *   npm run seed -- mastodon iphone-share-sheet
 *
 * Dedupe keys match the organic enqueuers, so seeding an angle simply makes
 * it happen NOW instead of whenever rotation would have reached it.
 */
import { ensureLocalDb } from "@/lib/localdb";
import { enqueue, evergreenKey, contentKey } from "@/lib/dedupe";
import { loadEvergreen } from "@/lib/sources/factbase";
import { titleCase } from "@/lib/enqueuers";
import { product } from "@/lib/product";
import { sql } from "@/lib/db/client";

const ACTOR = "seed:manual";

async function main() {
  await ensureLocalDb();
  const [channel, angleId] = process.argv.slice(2);
  const angles = loadEvergreen();
  const validChannels = ["blog", ...product().socialTargets];
  const angle = angles.find((a) => a.id === angleId);

  if (!channel || !validChannels.includes(channel) || !angle) {
    console.error(
      `Usage: npm run seed -- <channel> <angleId>\n` +
        `  channels: ${validChannels.join(", ")}\n` +
        `  angles:   ${angles.map((a) => a.id).join(", ")}`,
    );
    process.exit(1);
  }

  const linkPath = new URL(angle.cta).pathname || "/";
  const id =
    channel === "blog"
      ? await enqueue(ACTOR, {
          channel: "blog",
          sourceKind: "evergreen",
          dedupeKey: contentKey("blog", angle.id),
          payload: {
            sourceKind: "evergreen",
            linkPath,
            slug: angle.id,
            title: titleCase(angle.id),
            description: angle.brief.slice(0, 150),
            brief: angle.brief,
          },
        })
      : await enqueue(ACTOR, {
          channel,
          sourceKind: "evergreen",
          dedupeKey: evergreenKey(angle.id, channel),
          payload: {
            sourceKind: "evergreen",
            linkPath,
            angleId: angle.id,
            brief: angle.brief,
          },
        });

  console.log(
    id
      ? `[seed] enqueued ${channel}/${angle.id} (${id}) — processes on the next tick`
      : `[seed] a row with this dedupe key already exists — nothing enqueued ` +
          `(if it ended dry_run/skipped, use Retry in the dashboard instead)`,
  );
  await sql.end();
}

main().catch(async (e) => {
  console.error("[seed] FATAL:", e.message);
  try {
    await sql.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
