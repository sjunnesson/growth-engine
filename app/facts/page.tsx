import { readFactsRaw } from "@/lib/factsheet";
import { saveFactsAction } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function FactsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const { msg, err } = await searchParams;
  const { text, version } = readFactsRaw();

  return (
    <main>
      <h1>Fact base</h1>
      <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>
        The closed world: generated copy may only assert what is written here
        (plus verbatim release notes). Current version:{" "}
        <span className="pill good">{version}</span> — saving bumps it
        automatically, which invalidates the prompt cache and is recorded on
        every generated row. Keep claims literally true and conservative; when
        unsure, delete the line.
      </p>
      {msg && <div className="note">{msg}</div>}
      {err && (
        <div className="note" style={{ color: "var(--bad)" }}>
          {err}
        </div>
      )}

      <div className="card">
        <form action={saveFactsAction}>
          <textarea
            name="text"
            defaultValue={text}
            spellCheck={false}
            style={{
              width: "100%",
              minHeight: "60vh",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          />
          <button className="primary" type="submit" style={{ marginTop: 10 }}>
            Save (auto-bumps version)
          </button>
        </form>
        <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
          Takes effect on the next tick. Pricing changes must also update
          banned-claims.json (allowedPriceTokens) — that file is not edited
          here.
        </p>
      </div>
    </main>
  );
}
