// Product files as FORMS, not raw JSON: labeled fields for the config,
// one-pattern-per-line guardrails, add/edit/remove rows for the page briefs.
// All saves validate server-side before writing (app/files/actions.ts).
import { redirect } from "next/navigation";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isConfigured, productDir, productOrNull } from "@/lib/product";
import { SOCIAL_CHANNELS } from "@/lib/channels";
import {
  saveProductConfigAction,
  saveGuardrailsAction,
  addBannedPhraseAction,
  removeBannedPhraseAction,
  bulkBannedPhrasesAction,
  seoPageAction,
  comparisonAction,
} from "@/app/files/actions";
import { readablePattern } from "@/lib/guardrails/readable";


export const dynamic = "force-dynamic";

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

const label = { fontSize: 12, display: "block", marginTop: 8 } as const;
const full = { width: "100%" } as const;

function Field({
  name,
  title,
  def,
  placeholder = "",
  required = false,
}: {
  name: string;
  title: string;
  def: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label>{title}</label>
      <input name={name} defaultValue={def} placeholder={placeholder} required={required} />
    </div>
  );
}

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  if (!isConfigured()) redirect("/setup");
  const { msg, err } = await searchParams;
  const cfg = productOrNull()!;
  const fb = (f: string) => resolve(productDir(), "factbase", f);

  const banned = readJson<{
    allowedPriceTokens: string[];
    allowedDomains: string[];
    bannedPhrases: string[];
    requireSingleCanonicalLink: boolean;
    maxEmoji: number;
  }>(fb("banned-claims.json"), {
    allowedPriceTokens: [],
    allowedDomains: [cfg.domain],
    bannedPhrases: [],
    requireSingleCanonicalLink: true,
    maxEmoji: 1,
  });
  const seoPages = readJson<{ pages: { slug: string; audience: string; intent: string; primaryFeature: string }[] }>(
    fb("seo-pages.json"),
    { pages: [] },
  ).pages;
  const comparisons = readJson<{ comparisons: { slug: string; category: string; angle: string }[] }>(
    fb("comparisons.json"),
    { comparisons: [] },
  ).comparisons;

  return (
    <main>
      <h1>Product files</h1>
      <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>
        The rest of the closed world, as forms. Saves are checked before they
        land — a bad value is rejected with the reason, never written. The
        fact base and angles have their own pages.
      </p>
      {msg && <div className="note">{msg}</div>}
      {err && (
        <div className="note" style={{ color: "var(--bad)" }}>
          {err}
        </div>
      )}

      {/* ----------------------------------------------------------- product */}
      <section id="product">
        <h2>Product config</h2>
        <div className="card">
          <form action={saveProductConfigAction}>
            <div className="row fields">
              <Field name="name" title="Product name" def={cfg.name} required />
              <Field name="slug" title="Slug (internal id)" def={cfg.slug} />
              <Field name="domain" title="Canonical domain" def={cfg.domain} required />
              <Field name="siteUrl" title="Site URL" def={cfg.siteUrl} />
            </div>
            <div className="row fields">
              <Field name="websiteRepo" title="Website repo" def={cfg.github.websiteRepo} required />
              <Field name="websiteBranch" title="Website branch" def={cfg.github.websiteBranch} />
              <Field name="releasesRepo" title="Releases repo" def={cfg.github.releasesRepo} />
            </div>
            <div className="row fields">
              <Field name="ctaRelease" title="CTA path: release posts" def={cfg.cta.release} />
              <Field name="ctaSeo" title="CTA path: SEO pages" def={cfg.cta.seo} />
              <Field name="ctaComparison" title="CTA path: comparisons" def={cfg.cta.comparison} />
              <div className="field" style={{ maxWidth: 180 }}>
                <label>Content file format</label>
                <select name="format" defaultValue={cfg.site.format}>
                  <option value="markdown">markdown</option>
                  <option value="json">json</option>
                </select>
              </div>
              <div className="field" style={{ maxWidth: 180 }}>
                <label>Release tag scheme</label>
                <select name="tagScheme" defaultValue={cfg.releases.tagScheme}>
                  <option value="semver">semver</option>
                  <option value="any">any</option>
                </select>
              </div>
            </div>

            <label className="dim" style={label}>
              Social channels this product posts to
            </label>
            <div className="row">
              {SOCIAL_CHANNELS.map((ch) => (
                <label key={ch} style={{ fontSize: 13 }}>
                  <input
                    type="checkbox"
                    name="socialTargets"
                    value={ch}
                    defaultChecked={cfg.socialTargets.includes(ch)}
                  />{" "}
                  {ch}
                </label>
              ))}
            </div>

            <label className="dim" style={label}>
              Notes for the AI reviewer (one per line — product-specific violations to block)
            </label>
            <textarea
              name="criticNotes"
              defaultValue={(cfg.criticNotes ?? []).join("\n")}
              style={{ minHeight: 80 }}
            />

            <details>
              <summary className="dim" style={{ fontSize: 12, cursor: "pointer" }}>
                Advanced: website folders &amp; URL paths per content type
              </summary>
              <div className="row">
                {(["changelog", "blog", "seo", "comparison"] as const).map((ch) => (
                  <div key={ch} style={{ minWidth: 200 }}>
                    <label className="dim" style={label}>
                      {ch}: repo folder / public path
                    </label>
                    <input name={`dir_${ch}`} defaultValue={cfg.site.contentDirs[ch] ?? ""} style={full} />
                    <input name={`url_${ch}`} defaultValue={cfg.site.urlPaths[ch] ?? ""} style={{ ...full, marginTop: 4 }} />
                  </div>
                ))}
              </div>
            </details>

            <div style={{ marginTop: 12 }}>
              <button className="primary" type="submit">
                Save product config
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* ----------------------------------------------------- banned-claims */}
      <section id="banned-claims">
        <h2>Guardrails — what copy may never say</h2>
        <div className="card">
          <form action={saveGuardrailsAction}>
            <div className="row fields">
              <Field
                name="allowedPriceTokens"
                title="Allowed prices, comma-separated (empty = none ever)"
                def={banned.allowedPriceTokens.join(", ")}
                placeholder="$0, $19"
              />
              <Field
                name="allowedDomains"
                title="Allowed link domains, comma-separated"
                def={banned.allowedDomains.join(", ")}
                required
              />
              <div className="field" style={{ maxWidth: 140 }}>
                <label>Max emoji per post</label>
                <input name="maxEmoji" type="number" min={0} defaultValue={banned.maxEmoji} style={{ width: 80 }} />
              </div>
            </div>
            <label style={{ fontSize: 13, display: "block", marginTop: 10 }}>
              <input
                type="checkbox"
                name="requireSingleCanonicalLink"
                defaultChecked={banned.requireSingleCanonicalLink}
              />{" "}
              Require exactly one link per post, on an allowed domain
            </label>
            <div style={{ marginTop: 10 }}>
              <button className="primary" type="submit">
                Save settings
              </button>
            </div>
          </form>
        </div>

        <h2>Blocked phrases ({banned.bannedPhrases.length})</h2>
        <p className="dim" style={{ fontSize: 12, margin: "0 0 8px" }}>
          If generated copy contains one of these, it is blocked from
          publishing. &quot;a | b&quot; means any of those words matches.
          Engine-wide hype and AI-cliché rules are always active on top.
        </p>
        <div className="card">
          {banned.bannedPhrases.map((p) => {
            const r = readablePattern(p);
            return (
              <div
                key={p}
                className="row"
                style={{ padding: "5px 0", borderBottom: "1px solid var(--line)" }}
              >
                <span style={{ flex: 1 }}>
                  “{r.text.replace(/\|/g, " | ")}”
                  {r.isRegex && r.text === p && (
                    <span className="pill" style={{ marginLeft: 8 }}>pattern</span>
                  )}
                </span>
                <form action={removeBannedPhraseAction} className="inline">
                  <input type="hidden" name="phrase" value={p} />
                  <button className="ghost" type="submit">
                    Remove
                  </button>
                </form>
              </div>
            );
          })}
          <form action={addBannedPhraseAction} style={{ marginTop: 12 }}>
            <div className="row fields">
              <div className="field">
                <label>Block another phrase (plain text, e.g. &quot;money-back guarantee&quot;)</label>
                <input name="phrase" placeholder="free forever" required />
              </div>
              <div style={{ alignSelf: "flex-end" }}>
                <button className="primary" type="submit">
                  Add
                </button>
              </div>
            </div>
          </form>
          <details style={{ marginTop: 10 }}>
            <summary className="dim" style={{ fontSize: 12, cursor: "pointer" }}>
              Advanced: edit all as patterns (one per line)
            </summary>
            <form action={bulkBannedPhrasesAction}>
              <textarea
                name="bannedPhrases"
                defaultValue={banned.bannedPhrases.join("\n")}
                spellCheck={false}
                style={{ minHeight: 160, fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}
              />
              <button type="submit">Save all</button>
            </form>
          </details>
        </div>
      </section>

      {/* --------------------------------------------------------- seo pages */}
      <section id="seo-pages">
        <h2>SEO landing pages ({seoPages.length})</h2>
        <p className="dim" style={{ fontSize: 12, margin: "0 0 8px" }}>
          One page per entry. New slugs are picked up on the next tick;
          existing pages are never regenerated (edit-then-Retry from the Queue
          if you want one redone).
        </p>
        {seoPages.map((p) => (
          <div key={p.slug} className="card">
            <form action={seoPageAction}>
              <input type="hidden" name="originalSlug" value={p.slug} />
              <div className="row fields">
                <Field name="slug" title="Slug (the URL)" def={p.slug} required />
                <Field name="audience" title="Who it's for" def={p.audience} required />
              </div>
              <div className="row fields">
                <Field name="intent" title="Search intent it answers" def={p.intent} required />
                <Field name="primaryFeature" title="Feature it leans on" def={p.primaryFeature} required />
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button type="submit" name="op" value="save">
                  Save changes
                </button>
                <button className="ghost" type="submit" name="op" value="remove">
                  Remove
                </button>
              </div>
            </form>
          </div>
        ))}
        <div className="card">
          <form action={seoPageAction}>
            <strong style={{ fontSize: 13 }}>Add a page</strong>
            <div className="row fields">
              <Field name="slug" title="Slug" def="" placeholder="notes-from-screenshots" required />
              <Field name="audience" title="Who it's for" def="" placeholder="support teams" required />
            </div>
            <div className="row fields">
              <Field name="intent" title="Search intent" def="" placeholder="turn screenshots into searchable notes" required />
              <Field name="primaryFeature" title="Feature it leans on" def="" placeholder="on-device OCR" required />
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="primary" type="submit" name="op" value="save">
                Add page
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* ------------------------------------------------------- comparisons */}
      <section id="comparisons">
        <h2>Comparison pages ({comparisons.length})</h2>
        <p className="dim" style={{ fontSize: 12, margin: "0 0 8px" }}>
          Compare against a CATEGORY (&quot;meeting bots&quot;), never a named
          competitor — the guardrails block competitor claims. Highest-risk
          content: needs approval and an explicit LIVE_CHANNELS listing.
        </p>
        {comparisons.map((c) => (
          <div key={c.slug} className="card">
            <form action={comparisonAction}>
              <input type="hidden" name="originalSlug" value={c.slug} />
              <div className="row fields">
                <Field name="slug" title="Slug" def={c.slug} required />
                <Field name="category" title="Category compared against" def={c.category} required />
              </div>
              <Field name="angle" title="What makes this product's approach different (factually)" def={c.angle} required />
              <div className="row" style={{ marginTop: 10 }}>
                <button type="submit" name="op" value="save">
                  Save changes
                </button>
                <button className="ghost" type="submit" name="op" value="remove">
                  Remove
                </button>
              </div>
            </form>
          </div>
        ))}
        <div className="card">
          <form action={comparisonAction}>
            <strong style={{ fontSize: 13 }}>Add a comparison</strong>
            <div className="row fields">
              <Field name="slug" title="Slug" def="" placeholder="vs-meeting-bots" required />
              <Field name="category" title="Category" def="" placeholder="meeting bots" required />
            </div>
            <Field name="angle" title="The factual difference" def="" placeholder="no bot joins the call; everything runs locally" required />
            <div style={{ marginTop: 10 }}>
              <button className="primary" type="submit" name="op" value="save">
                Add comparison
              </button>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
