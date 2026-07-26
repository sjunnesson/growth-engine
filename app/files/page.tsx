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
  seoPageAction,
  comparisonAction,
} from "@/app/files/actions";

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
    <div style={{ flex: 1, minWidth: 180 }}>
      <label className="dim" style={label}>
        {title}
      </label>
      <input name={name} defaultValue={def} placeholder={placeholder} required={required} style={full} />
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
            <div className="row">
              <Field name="name" title="Product name" def={cfg.name} required />
              <Field name="slug" title="Slug (internal id)" def={cfg.slug} />
              <Field name="domain" title="Canonical domain (all links must live on it)" def={cfg.domain} required />
              <Field name="siteUrl" title="Site URL" def={cfg.siteUrl} />
            </div>
            <div className="row">
              <Field name="websiteRepo" title="Website repo (content gets committed here)" def={cfg.github.websiteRepo} required />
              <Field name="websiteBranch" title="Website branch" def={cfg.github.websiteBranch} />
              <Field name="releasesRepo" title="Releases repo (feeds the changelog)" def={cfg.github.releasesRepo} />
            </div>
            <div className="row">
              <Field name="ctaRelease" title="CTA path: release posts" def={cfg.cta.release} />
              <Field name="ctaSeo" title="CTA path: SEO pages" def={cfg.cta.seo} />
              <Field name="ctaComparison" title="CTA path: comparisons" def={cfg.cta.comparison} />
              <div style={{ flex: 1, minWidth: 140 }}>
                <label className="dim" style={label}>
                  Content file format
                </label>
                <select name="format" defaultValue={cfg.site.format}>
                  <option value="markdown">markdown</option>
                  <option value="json">json</option>
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label className="dim" style={label}>
                  Release tag scheme
                </label>
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
            <div className="row">
              <Field
                name="allowedPriceTokens"
                title="Exact prices copy may state, comma-separated (empty = no prices ever)"
                def={banned.allowedPriceTokens.join(", ")}
                placeholder="$0, $19"
              />
              <Field
                name="allowedDomains"
                title="Domains links may point to, comma-separated"
                def={banned.allowedDomains.join(", ")}
                required
              />
              <div style={{ minWidth: 120 }}>
                <label className="dim" style={label}>
                  Max emoji per post
                </label>
                <input name="maxEmoji" type="number" min={0} defaultValue={banned.maxEmoji} />
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
            <label className="dim" style={label}>
              Blocked phrases — one per line. Plain text works ("free forever");
              patterns work too ("better than (acme|other)"). A match blocks the
              copy from publishing. Engine-wide hype/AI-slop patterns are always
              active on top of these.
            </label>
            <textarea
              name="bannedPhrases"
              defaultValue={banned.bannedPhrases.join("\n")}
              spellCheck={false}
              style={{ minHeight: 160, fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}
            />
            <button className="primary" type="submit">
              Save guardrails
            </button>
          </form>
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
              <div className="row">
                <Field name="slug" title="Slug (the URL)" def={p.slug} required />
                <Field name="audience" title="Who it's for" def={p.audience} required />
              </div>
              <div className="row">
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
            <div className="row">
              <Field name="slug" title="Slug" def="" placeholder="notes-from-screenshots" required />
              <Field name="audience" title="Who it's for" def="" placeholder="support teams" required />
            </div>
            <div className="row">
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
              <div className="row">
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
            <div className="row">
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
