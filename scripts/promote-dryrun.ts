/**
 * Promote dry-run CONTENT rows (changelog/blog/seo) to pending so the next
 * tick publishes them for real — the bulk version of the dashboard's Retry
 * button, for after a phase flip adds channels to LIVE_CHANNELS.
 *
 *   npm run promote
 *
 * Social channels are deliberately excluded: their dry-run rows wait for
 * phase 3 and the approval queue.
 */
import { sql } from "@/lib/db/client";
import { retryItem } from "@/lib/queue";

async function main() {
  const rows = await sql<{ id: string; channel: string; dedupe_key: string }[]>`
    SELECT id, channel, dedupe_key FROM post_queue
    WHERE status = 'dry_run' AND channel IN ('changelog', 'blog', 'seo')
    ORDER BY created_at ASC`;
  if (!rows.length) {
    console.log("[promote] no dry-run content rows to promote.");
  }
  for (const r of rows) {
    const res = await retryItem(r.id);
    console.log(`[promote] ${r.channel} ${r.dedupe_key} -> ${res.ok ? "requeued" : res.message}`);
  }
  if (rows.length) {
    console.log(`[promote] ${rows.length} row(s) requeued — they publish on the next tick (launchd fires within 30 min, or run: npm run once)`);
  }
  await sql.end();
}

main().catch(async (e) => {
  console.error("[promote] FATAL:", e.message);
  try {
    await sql.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
