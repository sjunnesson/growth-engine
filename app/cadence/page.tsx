import {
  channelCadence,
  publishHistogram,
  upcomingItems,
  recentPublishes,
  nextPlanned,
} from "@/lib/cadence";
import type { ChannelCadence, PlannedNext } from "@/lib/cadence";
import { getCadenceSettings, CADENCE_DEFAULTS } from "@/lib/settings";
import type { CadenceSettings } from "@/lib/settings";
import { saveCadenceAction } from "@/app/actions";
import type { QueueRow } from "@/lib/db/client";

export const dynamic = "force-dynamic";

const HISTOGRAM_DAYS = 14;
const BLOCKS = "▁▂▃▄▅▆▇█";

/** Last N UTC day keys, oldest first — matches the cap windows. */
function dayKeys(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    new Date(Date.now() - (n - 1 - i) * 864e5).toISOString().slice(0, 10),
  );
}

function spark(counts: number[]): string {
  const max = Math.max(...counts, 1);
  return counts
    .map((n) =>
      n === 0 ? "·" : BLOCKS[Math.min(7, Math.ceil((n / max) * 7))],
    )
    .join("");
}

function rel(d: Date): string {
  const s = Math.round((Date.now() - +new Date(d)) / 1000);
  const abs = Math.abs(s);
  const fmt =
    abs < 90
      ? "1m"
      : abs < 5400
        ? `${Math.round(abs / 60)}m`
        : abs < 129600
          ? `${Math.round(abs / 3600)}h`
          : `${Math.round(abs / 86400)}d`;
  return s >= 0 ? `${fmt} ago` : `in ${fmt}`;
}

function budgetPill(used: number, cap: number, window: string) {
  const cls = used >= cap ? "bad" : used > 0 ? "good" : "";
  return (
    <span className={`pill ${cls}`} title={`${window} window (UTC)`}>
      {used}/{cap}
    </span>
  );
}

function planCell(p?: PlannedNext) {
  if (!p || p.kind === "none") return <span className="dim">—</span>;
  if (p.kind === "release") return <span className="dim">on next release</span>;
  if (p.kind === "approval")
    return (
      <>
        <span className="pill warn">on your approval</span>
        {p.what && <span className="dim"> {p.what}</span>}
      </>
    );
  return (
    <>
      {p.kind === "tick" ? (
        <span title="the runner ticks every ~30 min">next tick</span>
      ) : (
        <span title={new Date(p.when!).toLocaleString()}>{rel(p.when!)}</span>
      )}
      {p.what && <span className="dim"> · {p.what}</span>}
    </>
  );
}

function CadenceTable({
  rows,
  histogram,
  days,
  plans,
}: {
  rows: ChannelCadence[];
  histogram: Map<string, number>;
  days: string[];
  plans: Map<string, PlannedNext>;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>channel</th>
          <th>last post</th>
          <th>next planned</th>
          <th>24h</th>
          <th>7d</th>
          <th>30d</th>
          <th>today / cap</th>
          <th>hour / cap</th>
          <th>last {HISTOGRAM_DAYS} days</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const perDay = days.map(
            (d) => histogram.get(`${r.channel}:${d}`) ?? 0,
          );
          return (
            <tr key={r.channel}>
              <td>
                <code>{r.channel}</code>
              </td>
              <td className="dim">
                {r.lastPublishedAt ? (
                  <span title={new Date(r.lastPublishedAt).toLocaleString()}>
                    {rel(r.lastPublishedAt)}
                  </span>
                ) : (
                  "never"
                )}
              </td>
              <td>{planCell(plans.get(r.channel))}</td>
              <td>{r.last24h}</td>
              <td>{r.last7d}</td>
              <td>{r.last30d}</td>
              <td>{budgetPill(r.usedToday, r.capPerDay, "daily")}</td>
              <td>{budgetPill(r.usedThisHour, r.capPerHour, "hourly")}</td>
              <td>
                <span
                  style={{ letterSpacing: 1 }}
                  title={days
                    .map((d, i) => `${d}: ${perDay[i]}`)
                    .join("\n")}
                >
                  {spark(perDay)}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function UpcomingTable({ rows }: { rows: QueueRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>goes out</th>
          <th>channel</th>
          <th>source</th>
          <th>status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="dim">
              {r.status === "ready" ? (
                <span className="pill warn">on your approval</span>
              ) : (
                <span title={new Date(r.scheduled_for).toLocaleString()}>
                  {+new Date(r.scheduled_for) <= Date.now()
                    ? "next tick"
                    : rel(r.scheduled_for)}
                </span>
              )}
            </td>
            <td>
              <code>{r.channel}</code>
            </td>
            <td className="dim">{r.source_kind}</td>
            <td>{r.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PublishedTable({ rows }: { rows: QueueRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>published</th>
          <th>channel</th>
          <th>source</th>
          <th>artifact</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const artifact = (r.generated_meta as { artifactUrl?: string } | null)
            ?.artifactUrl;
          return (
            <tr key={r.id}>
              <td className="dim">{new Date(r.updated_at).toLocaleString()}</td>
              <td>
                <code>{r.channel}</code>
              </td>
              <td className="dim">{r.source_kind}</td>
              <td>
                {artifact ? (
                  <a href={artifact} target="_blank" rel="noreferrer">
                    {artifact.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="dim">{r.external_id ?? "—"}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default async function CadencePage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const { msg, err } = await searchParams;
  let cadence: ChannelCadence[] = [];
  let histogram = new Map<string, number>();
  let upcoming: QueueRow[] = [];
  let published: QueueRow[] = [];
  let plans = new Map<string, PlannedNext>();
  let cfg: CadenceSettings = { ...CADENCE_DEFAULTS };
  let dbError = "";
  try {
    [cadence, histogram, upcoming, published, cfg] = await Promise.all([
      channelCadence(),
      publishHistogram(HISTOGRAM_DAYS),
      upcomingItems(),
      recentPublishes(),
      getCadenceSettings(),
    ]);
    plans = await nextPlanned(cadence.map((c) => c.channel));
  } catch (e) {
    dbError = (e as Error).message;
  }
  const days = dayKeys(HISTOGRAM_DAYS);
  const every = (n: number) => (n === 1 ? "every day" : `every ${n} days`);

  return (
    <main>
      <h1>Cadence</h1>
      <p className="dim" style={{ fontSize: 12 }}>
        When posts actually go out. The tick runs every ~30 min; releases post
        as they ship (≤14 days old), evergreen social drips one angle per
        channel {every(cfg.socialIntervalDays)}, blog rotates{" "}
        {every(cfg.blogIntervalDays)}, SEO pages publish once per slug. The
        caps below are hard ceilings on top of that (UTC windows).
      </p>

      {msg && <div className="card" style={{ borderColor: "var(--good)" }}>{msg}</div>}
      {err && <div className="note">{err}</div>}

      {dbError ? (
        <div className="note">
          Database not reachable — set <code>DATABASE_URL</code>.
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
            {dbError}
          </div>
        </div>
      ) : (
        <>
          <h2>Per channel</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            {cadence.length === 0 ? (
              <span className="empty">Nothing published yet.</span>
            ) : (
              <CadenceTable
                rows={cadence}
                histogram={histogram}
                days={days}
                plans={plans}
              />
            )}
          </div>

          <h2>Frequency</h2>
          <div className="card">
            <form action={saveCadenceAction} className="row">
              <label className="row" style={{ gap: 6 }}>
                evergreen social: every
                <input
                  type="number"
                  name="socialIntervalDays"
                  min={1}
                  max={90}
                  defaultValue={cfg.socialIntervalDays}
                />
                day(s)
              </label>
              <label className="row" style={{ gap: 6 }}>
                blog: every
                <input
                  type="number"
                  name="blogIntervalDays"
                  min={1}
                  max={90}
                  defaultValue={cfg.blogIntervalDays}
                />
                day(s)
              </label>
              <button className="primary">Save</button>
            </form>
            <p className="dim" style={{ margin: "10px 0 0", fontSize: 12 }}>
              One evergreen angle per social channel, and one new blog angle,
              per interval. Changing an interval starts a fresh drip period —
              the next tick may queue an item right away (it still waits for
              your approval). Releases and SEO pages are event/slug driven, and
              the per-day/hour caps above are fixed safety ceilings.
            </p>
          </div>

          <h2>Next up</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            {upcoming.length === 0 ? (
              <span className="empty">
                Nothing queued yet — the &ldquo;next planned&rdquo; column above
                shows what the coming ticks will enqueue.
              </span>
            ) : (
              <UpcomingTable rows={upcoming} />
            )}
          </div>

          <h2>Recent publishes</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            {published.length === 0 ? (
              <span className="empty">Nothing published yet.</span>
            ) : (
              <PublishedTable rows={published} />
            )}
          </div>
        </>
      )}
    </main>
  );
}
