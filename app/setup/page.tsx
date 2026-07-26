// Guided onboarding. One server-rendered state machine:
//   1. no product/          → prereq checks + repo/vault + interview form
//   2. drafting in flight   → live progress (status file, auto-refresh)
//   3. product unreviewed   → review checklist: drafts, env, migrate, dry-run,
//                             and the human sign-off
//   4. reviewed             → done panel
import Link from "next/link";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { isConfigured, productOrNull } from "@/lib/product";
import { defaultAnswers, readSetupStatus, type SetupStatus } from "@/lib/setup";
import { loadEvergreen, loadSeoPages, loadComparisons } from "@/lib/sources/factbase";
import { readFactsRaw } from "@/lib/factsheet";
import { markReviewedAction } from "@/app/actions";
import { isManagedUrl } from "@/lib/localdb";
import {
  startSetupAction,
  createLocalDbAction,
  resetSetupAction,
  saveEnvAction,
  migrateAction,
  dryrunAction,
  tickNowAction,
} from "@/app/setup/actions";
import AutoRefresh from "@/app/setup/AutoRefresh";

export const dynamic = "force-dynamic";

const ROOT = process.cwd();

function which(bin: string): string {
  try {
    return execFileSync("which", [bin], { encoding: "utf-8", timeout: 3_000 }).trim();
  } catch {
    return "";
  }
}

function envLocal(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

function tail(file: string, lines: number): string {
  try {
    return readFileSync(resolve(ROOT, file), "utf-8").trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function Pill({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={`pill ${ok ? "good" : "bad"}`}>{ok ? yes : no}</span>;
}

function Msg({ msg, err }: { msg?: string; err?: string }) {
  return (
    <>
      {msg && <div className="note">{msg}</div>}
      {err && (
        <div className="note" style={{ color: "var(--bad)" }}>
          {err}
        </div>
      )}
    </>
  );
}

const STAGES: [SetupStatus["stage"], string][] = [
  ["analyzing", "Analyzing the product repo"],
  ["vault", "Mining the notes vault"],
  ["facts", "Drafting the fact base"],
  ["guardrails", "Drafting guardrail patterns"],
  ["plan", "Drafting angles, SEO pages, comparisons"],
  ["writing", "Writing product/"],
];

function Progress({ status, logTail }: { status: SetupStatus; logTail: string }) {
  const idx = STAGES.findIndex(([k]) => k === status.stage);
  return (
    <div className="card">
      <AutoRefresh />
      <strong>Drafting your product config…</strong>
      <p className="dim" style={{ fontSize: 12, margin: "6px 0 10px" }}>
        Runs a few minutes: several Claude CLI calls draft the closed-world
        fact base and content plan from your repo{status.detail ? ` (${status.detail})` : ""}.
        This page refreshes itself.
      </p>
      {STAGES.map(([key, label], i) => (
        <div key={key} className="row" style={{ padding: "4px 0" }}>
          <span className={`pill ${i < idx ? "good" : i === idx ? "warn" : ""}`}>
            {i < idx ? "done" : i === idx ? "running" : "pending"}
          </span>
          <span className={i > idx ? "dim" : undefined}>{label}</span>
        </div>
      ))}
      {logTail && (
        <pre style={{ fontSize: 11.5, marginTop: 10, whiteSpace: "pre-wrap" }}>{logTail}</pre>
      )}
      <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
        Full log: <code>.setup.log</code> · started{" "}
        {new Date(status.startedAt).toLocaleTimeString()}
      </p>
    </div>
  );
}

/** Is the scheduler (menu bar app / launchd) actually feeding the engine?
 *  `dbSet` is the CURRENT truth about the database — the tick's verdict in
 *  .status.json can predate it, and a stale "no database yet" next to a green
 *  database card reads as a contradiction. */
function EngineStatusCard({ dbSet }: { dbSet: boolean }) {
  let ts: Date | null = null;
  let incomplete = "";
  try {
    const s = JSON.parse(readFileSync(resolve(ROOT, ".status.json"), "utf-8"));
    ts = s.ts ? new Date(s.ts) : null;
    incomplete = s.setupIncomplete ?? "";
  } catch {
    /* no tick yet */
  }
  const staleVerdict = dbSet && /database/i.test(incomplete);
  const fresh = ts !== null && Date.now() - ts.getTime() < 40 * 60 * 1000;
  const when = ts ? ts.toLocaleTimeString() : "";
  return (
    <div className="card">
      <div className="row">
        <Pill
          ok={fresh}
          yes={`scheduler active — last tick ${when}`}
          no={ts ? `last tick ${when} (stale)` : "no tick recorded yet"}
        />
        {incomplete && !staleVerdict && (
          <span className="pill warn">tick idling: {incomplete}</span>
        )}
        {staleVerdict && (
          <span className="pill">last tick ran before the database existed — refreshing</span>
        )}
        <form action={tickNowAction} className="inline" style={{ marginLeft: "auto" }}>
          <button className="ghost" type="submit">Run tick now</button>
        </form>
      </div>
      {staleVerdict && <AutoRefresh seconds={5} />}
      <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>
        The menu bar app is the scheduler: it runs a tick every 30 minutes
        while it&apos;s open. Not built yet? <code>./deploy/build-menubar.sh</code>{" "}
        then add the app to Login Items.
      </p>
    </div>
  );
}

function InterviewForm() {
  const d = defaultAnswers();
  const F = ({
    name,
    label,
    def = "",
    placeholder = "",
    required = false,
  }: {
    name: string;
    label: string;
    def?: string;
    placeholder?: string;
    required?: boolean;
  }) => (
    <div style={{ marginBottom: 10 }}>
      <label className="dim" style={{ fontSize: 12, display: "block" }}>
        {label}
      </label>
      <input
        name={name}
        defaultValue={def}
        placeholder={placeholder}
        required={required}
        style={{ width: "100%" }}
      />
    </div>
  );

  return (
    <form action={startSetupAction}>
      <h2>1 · What to analyze</h2>
      <div className="card">
        <F name="repoPath" label="Product source repo (absolute path on this Mac)" placeholder="/Users/you/code/yourapp" required />
        <F name="vaultPath" label="Obsidian vault / notes folder to mine (optional)" placeholder="/Users/you/Obsidian/YourVault" />
      </div>

      <h2>2 · Identity</h2>
      <div className="card">
        <F name="name" label="Product name" placeholder="Acme" required />
        <F name="slug" label="Slug (kebab-case id; defaults to the name)" placeholder="acme" />
        <F name="domain" label="Canonical domain (generated links must live on it)" placeholder="acme.example" required />
        <F name="siteUrl" label="Site URL (defaults to https://<domain>)" placeholder="https://acme.example" />
      </div>

      <h2>3 · Repos & channels</h2>
      <div className="card">
        <F name="websiteRepo" label="Website GitHub repo the engine commits content into (owner/repo or URL)" placeholder="you/yoursite" required />
        <F name="websiteBranch" label="Website branch" def="main" />
        <F name="releasesRepo" label="Repo whose GitHub Releases feed the changelog (defaults to the website repo)" placeholder="you/yourapp" />
        <F name="socialTargets" label="Social channels to target (comma-separated: mastodon,bluesky,linkedin,reddit,x)" def={d.socialTargets.join(",")} />
        <div className="row">
          <div style={{ flex: 1 }}>
            <label className="dim" style={{ fontSize: 12, display: "block" }}>
              Content file format
            </label>
            <select name="format" defaultValue="markdown">
              <option value="markdown">markdown (frontmatter)</option>
              <option value="json">json</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label className="dim" style={{ fontSize: 12, display: "block" }}>
              Release tag scheme
            </label>
            <select name="tagScheme" defaultValue="semver">
              <option value="semver">semver (patch-collapse)</option>
              <option value="any">any (announce every release)</option>
            </select>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ flex: 1 }}>
            <label className="dim" style={{ fontSize: 12, display: "block" }}>CTA path: releases</label>
            <input name="ctaRelease" defaultValue="/" style={{ width: "100%" }} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="dim" style={{ fontSize: 12, display: "block" }}>CTA path: SEO pages</label>
            <input name="ctaSeo" defaultValue="/" style={{ width: "100%" }} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="dim" style={{ fontSize: 12, display: "block" }}>CTA path: comparisons</label>
            <input name="ctaComparison" defaultValue="/" style={{ width: "100%" }} />
          </div>
        </div>
      </div>

      <h2>4 · Truth the analysis cannot infer</h2>
      <div className="card">
        <F name="priceTokens" label="EXACT allowed price tokens, comma-separated (empty = no prices may EVER appear in copy)" placeholder="$0,$19" />
        <div style={{ marginBottom: 10 }}>
          <label className="dim" style={{ fontSize: 12, display: "block" }}>
            Pricing model in one or two sentences (&apos;none&apos; if unpriced)
          </label>
          <textarea name="pricingNotes" placeholder="Free tier capped at N. Pro is a one-time $X, no subscription." />
        </div>
        <F name="competitors" label="Competitor/category names copy must never characterize (comma-separated)" placeholder="SomeApp, OtherApp" />
        <div>
          <label className="dim" style={{ fontSize: 12, display: "block" }}>
            Anything the copy must NEVER claim (free-form)
          </label>
          <textarea name="neverClaim" placeholder="Never claim cloud sync; never call the OCR AI-powered." />
        </div>
      </div>

      <button className="primary" type="submit">
        Analyze &amp; draft the product config
      </button>
      <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
        Drafting takes a few minutes and writes DRAFTS only — nothing can
        publish until you review and sign off (next step on this page).
      </p>
    </form>
  );
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const { msg, err } = await searchParams;
  const configured = isConfigured();
  const cfg = productOrNull();
  const status = readSetupStatus();

  // --- state 4: fully configured + reviewed ---------------------------------
  if (configured && cfg?.reviewed) {
    return (
      <main>
        <h1>Setup</h1>
        <Msg msg={msg} err={err} />
        <div className="card">
          <span className="pill good">configured</span>{" "}
          <strong>{cfg.name}</strong> is set up and reviewed.
          <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>
            Posture and kill switches: <Link href="/">Overview</Link> · go-live
            rollout: set <code>LIVE_CHANNELS</code> in <code>.env.local</code>{" "}
            one channel at a time (see SETUP.md). To rename the menu bar app
            for this product, re-run <code>./deploy/build-menubar.sh</code>.
          </p>
        </div>
      </main>
    );
  }

  // --- state 3: drafted, awaiting human review ------------------------------
  if (configured && cfg) {
    let angles = 0,
      seo = 0,
      comparisons = 0,
      todos = 0;
    try {
      angles = loadEvergreen().length;
      seo = loadSeoPages().length;
      comparisons = loadComparisons().length;
      todos = (readFactsRaw().text.match(/TODO\(verify\)/g) ?? []).length;
    } catch {
      /* partial product dir — the checklist below still renders */
    }
    const el = envLocal();
    const dbUrl = el.DATABASE_URL || process.env.DATABASE_URL || "";
    const dbSet = Boolean(dbUrl);
    const dbManaged = isManagedUrl(dbUrl);
    const ghSet = Boolean(el.GITHUB_TOKEN || process.env.GITHUB_TOKEN);
    const dryTail = tail(".dryrun.log", 8);

    return (
      <main>
        <h1>Setup — review &amp; arm</h1>
        <Msg msg={msg} err={err} />
        <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>
          <strong>{cfg.name}</strong> is drafted but not reviewed: every
          channel is forced to dry-run. Work through the checklist, then sign
          off at the bottom.
        </p>

        <h2>A · Review the drafts (human judgment — the whole point)</h2>
        <div className="card">
          <div className="row">
            <span className={`pill ${todos ? "warn" : "good"}`}>
              {todos} TODO(verify)
            </span>
            <span className="pill">{angles} angles</span>
            <span className="pill">{seo} SEO pages</span>
            <span className="pill">{comparisons} comparisons</span>
          </div>
          <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>
            Fix every TODO and delete anything not literally true in the{" "}
            <Link href="/facts">fact base</Link>; curate{" "}
            <Link href="/angles">angles</Link>; review{" "}
            <code>product/factbase/banned-claims.json</code> and{" "}
            <code>product/product.json</code> in your editor.
          </p>
        </div>

        <h2>B · Database</h2>
        <div className="card">
          {dbSet ? (
            <>
              <div className="row">
                <Pill
                  ok
                  yes={dbManaged ? "private local database (.pgdata) — starts automatically" : "external database connected"}
                  no=""
                />
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <form action={migrateAction} className="inline">
                  <button className="ghost" type="submit">Re-apply schema</button>
                </form>
                <span className="dim" style={{ fontSize: 12 }}>idempotent; safe anytime</span>
              </div>
            </>
          ) : (
            <>
              <form action={createLocalDbAction}>
                <button className="primary" type="submit">
                  Create a local database for me
                </button>
              </form>
              <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>
                Makes a private database inside this folder (<code>.pgdata/</code>),
                sets everything up, and starts it automatically whenever the
                engine runs. Nothing to install, no account, takes ~10 seconds.
              </p>
              <details style={{ marginTop: 10 }}>
                <summary className="dim" style={{ fontSize: 12, cursor: "pointer" }}>
                  Advanced: I already run Postgres
                </summary>
                <form action={saveEnvAction} style={{ marginTop: 8 }}>
                  <input
                    name="DATABASE_URL"
                    placeholder={`postgres://user:pass@localhost:5432/${cfg.slug}_growth`}
                    style={{ width: "100%", marginBottom: 8 }}
                  />
                  <button type="submit">Connect (applies the schema too)</button>
                  <p className="dim" style={{ fontSize: 12, margin: "6px 0 0" }}>
                    One database per engine instance — never share one between
                    two products.
                  </p>
                </form>
              </details>
            </>
          )}
        </div>

        <h2>C · Publishing &amp; scheduler</h2>
        <EngineStatusCard dbSet={dbSet} />
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <Pill ok={ghSet} yes="GitHub token set" no="GitHub token missing — release polling + website publishing stay off" />
            <span className="pill">dashboard port {el.PORT || "3400 (default)"}</span>
          </div>
          <form action={saveEnvAction}>
            <div className="row">
              <div style={{ flex: 2 }}>
                <label className="dim" style={{ fontSize: 12, display: "block" }}>
                  GitHub token — lets the engine read your releases and commit
                  content to your website repo (fine-grained PAT; optional until
                  you go live)
                </label>
                <input name="GITHUB_TOKEN" type="password" placeholder="github_pat_…" style={{ width: "100%" }} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="dim" style={{ fontSize: 12, display: "block" }}>
                  Dashboard port (unique per instance)
                </label>
                <input name="PORT" placeholder={el.PORT || "3400"} style={{ width: "100%" }} />
              </div>
            </div>
            <button type="submit" style={{ marginTop: 8 }}>
              Save
            </button>
          </form>
        </div>

        <h2>D · Verify end-to-end (still dry-run)</h2>
        <div className="card">
          <form action={dryrunAction} className="inline">
            <button type="submit">Run the dry-run drill</button>
          </form>
          <span className="dim" style={{ fontSize: 12, marginLeft: 8 }}>
            guardrail self-test + a full pipeline pass; takes minutes, nothing
            leaves the machine
          </span>
          {dryTail && (
            <>
              <AutoRefresh seconds={6} />
              <pre style={{ fontSize: 11.5, marginTop: 10, whiteSpace: "pre-wrap" }}>{dryTail}</pre>
            </>
          )}
        </div>

        <h2>E · Sign off</h2>
        <div className="card" style={{ borderColor: "var(--warn)" }}>
          <p className="dim" style={{ fontSize: 12, margin: "0 0 10px" }}>
            This is the closed-world guarantee: by confirming, you assert every
            line of the fact base is literally true. Live posture then follows{" "}
            <code>DRY_RUN</code> / <code>LIVE_CHANNELS</code> (both still
            conservative defaults).
          </p>
          <form action={markReviewedAction}>
            <button className="primary" type="submit">
              I reviewed the fact base — arm live posture
            </button>
          </form>
        </div>
      </main>
    );
  }

  // --- state 2: drafting in flight ------------------------------------------
  if (status && status.stage !== "error" && status.stage !== "done" && status.startedAt) {
    return (
      <main>
        <h1>Setup</h1>
        <Msg msg={msg} err={err} />
        <Progress status={status} logTail={tail(".setup.log", 12)} />
      </main>
    );
  }

  // --- state 1: fresh checkout — prereqs + interview ------------------------
  const claudePath = which("claude");
  const gitPath = which("git");
  return (
    <main>
      <h1>Set up a product</h1>
      <Msg msg={msg} err={err} />
      {status?.stage === "error" && (
        <div className="note" style={{ color: "var(--bad)" }}>
          The last run failed: {status.error}
          <form action={resetSetupAction} className="inline" style={{ marginLeft: 8 }}>
            <button className="ghost" type="submit">Dismiss</button>
          </form>
        </div>
      )}
      <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>
        Point the engine at your product. It analyzes the repo (and optionally
        your notes) with the Claude CLI, then drafts the fact base, guardrails,
        and content plan for your review. Nothing publishes until you sign off.
      </p>

      <h2>Prerequisites</h2>
      <div className="card">
        <div className="row">
          <Pill ok={Boolean(claudePath)} yes={`claude CLI (${claudePath})`} no="claude CLI not on PATH — install + authenticate Claude Code first" />
          <Pill ok={Boolean(gitPath)} yes="git" no="git not found" />
          <span className="pill">node {process.version}</span>
        </div>
        <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>
          Postgres and a GitHub token come later (the review step) — drafting
          needs neither.
        </p>
      </div>

      <InterviewForm />
    </main>
  );
}
