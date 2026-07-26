import { redirect } from "next/navigation";
import { isConfigured } from "@/lib/product";
import { awaitingApproval, recentItems } from "@/lib/queue";
import { approveAction, rejectAction, retryAction } from "@/app/actions";

export const dynamic = "force-dynamic";

function statusPill(s: string) {
  const cls =
    s === "published"
      ? "good"
      : s === "failed" || s === "skipped"
        ? "bad"
        : s === "ready" || s === "approved" || s === "dry_run"
          ? "warn"
          : "";
  return <span className={`pill ${cls}`}>{s}</span>;
}

export default async function QueuePage() {
  if (!isConfigured()) redirect("/setup");
  let ready: Awaited<ReturnType<typeof awaitingApproval>> = [];
  let recent: Awaited<ReturnType<typeof recentItems>> = [];
  let dbError = "";
  try {
    [ready, recent] = await Promise.all([awaitingApproval(), recentItems(40)]);
  } catch (e) {
    dbError = (e as Error).message;
  }

  if (dbError)
    return (
      <main>
        <h1>Queue &amp; approvals</h1>
        <div className="note">
          Database not reachable — set <code>DATABASE_URL</code> and run{" "}
          <code>npm run db:migrate</code>.
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
            {dbError}
          </div>
        </div>
      </main>
    );

  return (
    <main>
      <h1>Queue &amp; approvals</h1>

      <h2>Awaiting your approval ({ready.length})</h2>
      {ready.length === 0 ? (
        <p className="empty">
          Nothing waiting. Social posts, blog posts, SEO pages &amp;
          comparisons land here before they publish; only changelog entries
          publish unattended.
        </p>
      ) : (
        ready.map((r) => (
          <div key={r.id} className="card">
            <div className="row">
              <span className="pill warn">{r.channel}</span>
              <span className="pill">{r.source_kind}</span>
              <span className="dim" style={{ fontSize: 12 }}>
                {new Date(r.created_at).toLocaleString()}
              </span>
            </div>

            <form action={approveAction}>
              <input type="hidden" name="id" value={r.id} />
              <textarea
                name="text"
                defaultValue={r.generated_text ?? ""}
                spellCheck={false}
              />
              <p className="dim" style={{ fontSize: 12, margin: "0 0 8px" }}>
                Link: <code>{r.utm ?? "(none)"}</code> — edits are re-checked by
                the deterministic lint before publishing.
              </p>
              <button className="primary" type="submit">
                Approve &amp; publish next tick
              </button>
            </form>

            <form action={rejectAction} className="inline">
              <input type="hidden" name="id" value={r.id} />
              <input
                type="hidden"
                name="reason"
                value="rejected via dashboard"
              />
              <button className="ghost" type="submit" style={{ marginTop: 8 }}>
                Reject
              </button>
            </form>
          </div>
        ))
      )}

      <h2>Recent ({recent.length})</h2>
      <div className="card" style={{ overflowX: "auto" }}>
        {recent.length === 0 ? (
          <span className="empty">No history yet.</span>
        ) : (
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>channel</th>
                <th>kind</th>
                <th>status</th>
                <th>text / error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className="dim">
                    {new Date(r.updated_at).toLocaleString()}
                  </td>
                  <td>{r.channel}</td>
                  <td className="dim">{r.source_kind}</td>
                  <td>{statusPill(r.status)}</td>
                  <td style={{ maxWidth: 380 }}>
                    {r.last_error ? (
                      <span style={{ color: "var(--bad)" }}>{r.last_error}</span>
                    ) : (
                      <span className="dim">
                        {(r.generated_text ?? "").slice(0, 140)}
                      </span>
                    )}
                  </td>
                  <td>
                    {r.status === "published" &&
                      (() => {
                        const art = (
                          r.generated_meta as Record<string, unknown> | null
                        )?.artifactUrl as string | undefined;
                        return art ? (
                          <a href={art} target="_blank" rel="noopener">
                            view&nbsp;↗
                          </a>
                        ) : null;
                      })()}
                    {(r.status === "failed" ||
                      r.status === "skipped" ||
                      r.status === "dry_run") && (
                      <form action={retryAction} className="inline">
                        <input type="hidden" name="id" value={r.id} />
                        <button className="ghost">Retry</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
