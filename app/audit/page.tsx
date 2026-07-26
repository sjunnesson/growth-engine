import { redirect } from "next/navigation";
import { isConfigured } from "@/lib/product";
import { recentAudit } from "@/lib/queue";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  if (!isConfigured()) redirect("/setup");
  let rows: Awaited<ReturnType<typeof recentAudit>> = [];
  let dbError = "";
  try {
    rows = await recentAudit(80);
  } catch (e) {
    dbError = (e as Error).message;
  }

  return (
    <main>
      <h1>Audit log</h1>
      <p className="dim" style={{ fontSize: 12 }}>
        Append-only decision trail. Combined with the website repo&apos;s git
        history this is the full record of what the engine did and why.
      </p>

      {dbError ? (
        <div className="note">
          Database not reachable — set <code>DATABASE_URL</code>.
          <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
            {dbError}
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          {rows.length === 0 ? (
            <span className="empty">No audit entries yet.</span>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>ts</th>
                  <th>actor</th>
                  <th>action</th>
                  <th>lvl</th>
                  <th>detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="dim">
                      {new Date(r.ts).toLocaleString()}
                    </td>
                    <td>{r.actor}</td>
                    <td>
                      <span
                        className={`pill ${
                          r.action === "publish" || r.action === "approved"
                            ? "good"
                            : r.action.includes("block") ||
                                r.action.includes("error") ||
                                r.action.includes("abort") ||
                                r.action === "rejected"
                              ? "bad"
                              : ""
                        }`}
                      >
                        {r.action}
                      </span>
                    </td>
                    <td className="dim">{r.level}</td>
                    <td style={{ maxWidth: 460 }}>
                      <code style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
                        {JSON.stringify(r.detail).slice(0, 240)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </main>
  );
}
