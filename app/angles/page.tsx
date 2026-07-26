import { loadEvergreen } from "@/lib/sources/factbase";
import { rotationIndex } from "@/lib/dedupe";
import { getCadenceSettings } from "@/lib/settings";
import { product } from "@/lib/product";
import { sql } from "@/lib/db/client";
import { addAngleAction, removeAngleAction } from "@/app/actions";

export const dynamic = "force-dynamic";

interface Usage {
  blog: string | null;
  socialPublished: number;
}

async function loadUsage(): Promise<Map<string, Usage>> {
  const rows = await sql<{ dedupe_key: string; status: string }[]>`
    SELECT dedupe_key, status FROM post_queue
    WHERE dedupe_key LIKE 'evergreen:%' OR dedupe_key LIKE 'content:blog:%'`;
  const map = new Map<string, Usage>();
  const get = (id: string) => {
    if (!map.has(id)) map.set(id, { blog: null, socialPublished: 0 });
    return map.get(id)!;
  };
  for (const r of rows) {
    if (r.dedupe_key.startsWith("content:blog:")) {
      get(r.dedupe_key.slice("content:blog:".length)).blog = r.status;
    } else {
      const id = r.dedupe_key.split(":")[1];
      if (id && r.status === "published") get(id).socialPublished++;
    }
  }
  return map;
}

export default async function AnglesPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const { msg, err } = await searchParams;
  const angles = loadEvergreen();
  const cadence = await getCadenceSettings();
  // Same rotation math as the enqueuers, so the pills match what the next
  // tick will actually pick.
  const now = new Date();
  const socialNow = rotationIndex(now, cadence.socialIntervalDays) % angles.length;
  const blogNow = rotationIndex(now, cadence.blogIntervalDays) % angles.length;

  let usage = new Map<string, Usage>();
  let dbError = "";
  try {
    usage = await loadUsage();
  } catch (e) {
    dbError = (e as Error).message;
  }

  return (
    <main>
      <h1>Evergreen angles</h1>
      <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>
        Each angle is a brief, not copy. It feeds the drip rotation: one blog
        post (once, ever) and one social post per channel per period (every{" "}
        {cadence.socialIntervalDays}d social / {cadence.blogIntervalDays}d blog
        — tune on the Cadence page) when its turn comes. Guardrails apply to
        the generated copy as usual.
      </p>
      {msg && <div className="note">{msg}</div>}
      {err && (
        <div className="note" style={{ color: "var(--bad)" }}>
          {err}
        </div>
      )}
      {dbError && (
        <div className="note dim" style={{ fontSize: 12 }}>
          Usage stats unavailable (DB: {dbError})
        </div>
      )}

      <h2>Add an angle</h2>
      <div className="card">
        <form action={addAngleAction}>
          <label className="dim" style={{ fontSize: 12 }}>
            id (kebab-case, becomes the blog slug)
          </label>
          <input
            name="id"
            placeholder="canvas-moodboards"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            style={{ width: "100%", marginBottom: 8 }}
          />
          <label className="dim" style={{ fontSize: 12 }}>
            brief (what the copy should be about; facts must exist in the fact
            base)
          </label>
          <textarea
            name="brief"
            required
            minLength={20}
            maxLength={400}
            placeholder="The canvas view works like a moodboard: drag saved assets around, group them spatially, keep project references together."
          />
          <label className="dim" style={{ fontSize: 12 }}>
            CTA URL (allowed domains only)
          </label>
          <input
            name="cta"
            type="url"
            required
            defaultValue={product().siteUrl}
            style={{ width: "100%", marginBottom: 10 }}
          />
          <button className="primary" type="submit">
            Add angle
          </button>
        </form>
        <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
          New angles join the rotation immediately (the next tick can pick
          them up). Adding or removing an angle shifts the rotation order —
          that is harmless, the per-period dedupe prevents double posting.
        </p>
      </div>

      <h2>Current angles ({angles.length})</h2>
      {angles.map((a, i) => {
        const u = usage.get(a.id);
        return (
          <div key={a.id} className="card">
            <div className="row">
              <strong>{a.id}</strong>
              {i === socialNow && i === blogNow ? (
                <span className="pill warn">up now</span>
              ) : (
                <>
                  {i === socialNow && <span className="pill warn">social now</span>}
                  {i === blogNow && <span className="pill warn">blog now</span>}
                </>
              )}
              {u?.blog === "published" ? (
                <span className="pill good">blog published</span>
              ) : u?.blog ? (
                <span className="pill">blog: {u.blog}</span>
              ) : (
                <span className="pill">blog not yet written</span>
              )}
              <span className="pill">
                {u?.socialPublished ?? 0} social post{(u?.socialPublished ?? 0) === 1 ? "" : "s"}
              </span>
              <form action={removeAngleAction} className="inline" style={{ marginLeft: "auto" }}>
                <input type="hidden" name="id" value={a.id} />
                <button className="ghost" type="submit">
                  Remove
                </button>
              </form>
            </div>
            <p style={{ margin: "8px 0 4px" }}>{a.brief}</p>
            <span className="dim" style={{ fontSize: 12 }}>
              CTA: <code>{a.cta}</code>
            </span>
          </div>
        );
      })}
      <p className="dim" style={{ fontSize: 12 }}>
        Removing an angle stops future posts from it; already-published blog
        posts and toots stay live.
      </p>
    </main>
  );
}
