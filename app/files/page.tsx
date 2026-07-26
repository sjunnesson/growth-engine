// Product files — everything the review checklist points at that isn't the
// fact base (its own page) or angles (their own page). Raw-but-validated
// JSON editing: a bad save is rejected with the specific problem, never
// written.
import { redirect } from "next/navigation";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isConfigured, productDir } from "@/lib/product";
import { saveProductFileAction } from "@/app/files/actions";

export const dynamic = "force-dynamic";

const SECTIONS: {
  key: string;
  title: string;
  path: (dir: string) => string;
  blurb: string;
}[] = [
  {
    key: "product",
    title: "product.json — identity & wiring",
    path: (d) => resolve(d, "product.json"),
    blurb:
      "Name, domain, repos, CTA paths, site layout, social targets, critic notes. Validated on save (a broken file here would take the dashboard down, so invalid saves are rejected).",
  },
  {
    key: "banned-claims",
    title: "banned-claims.json — guardrail patterns",
    blurb:
      "Product-specific patterns that BLOCK generated copy on match (engine-generic AI-slop patterns merge in automatically). Each regex is compiled before saving; allowedPriceTokens is the complete list of prices copy may ever state.",
    path: (d) => resolve(d, "factbase", "banned-claims.json"),
  },
  {
    key: "seo-pages",
    title: "seo-pages.json — landing-page briefs",
    blurb:
      "One entry per programmatic landing page (slug, audience, intent, primaryFeature). content-sync picks up new slugs on the next tick; existing slugs are never regenerated.",
    path: (d) => resolve(d, "factbase", "seo-pages.json"),
  },
  {
    key: "comparisons",
    title: "comparisons.json — comparison-page briefs",
    blurb:
      "Category comparisons (never named competitors). Highest-risk content type: pages need approval AND the channel must be explicitly listed in LIVE_CHANNELS.",
    path: (d) => resolve(d, "factbase", "comparisons.json"),
  },
];

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  if (!isConfigured()) redirect("/setup");
  const { msg, err } = await searchParams;
  const dir = productDir();

  return (
    <main>
      <h1>Product files</h1>
      <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>
        The rest of the closed world: config and briefs the engine reads every
        tick. Saves are validated — an invalid file is rejected, not written.
        The fact base and angles have their own pages.
      </p>
      {msg && <div className="note">{msg}</div>}
      {err && (
        <div className="note" style={{ color: "var(--bad)" }}>
          {err}
        </div>
      )}

      {SECTIONS.map((s) => {
        let text = "";
        let missing = "";
        try {
          text = readFileSync(s.path(dir), "utf-8");
        } catch {
          missing = "file missing — saving will create it";
        }
        return (
          <section key={s.key} id={s.key}>
            <h2>{s.title}</h2>
            <div className="card">
              <p className="dim" style={{ fontSize: 12, margin: "0 0 8px" }}>
                {s.blurb} {missing && <span className="pill warn">{missing}</span>}
              </p>
              <form action={saveProductFileAction}>
                <input type="hidden" name="file" value={s.key} />
                <textarea
                  name="text"
                  defaultValue={text}
                  spellCheck={false}
                  style={{
                    minHeight: 180,
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 12.5,
                    lineHeight: 1.5,
                  }}
                />
                <button className="primary" type="submit">
                  Validate &amp; save
                </button>
              </form>
            </div>
          </section>
        );
      })}
    </main>
  );
}
