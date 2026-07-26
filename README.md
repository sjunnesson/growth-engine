# growth-engine

Autonomous marketing engine you point at a product. One engine checkout runs
**one product**; everything product-specific lives in `product/`
(`product.json` + `factbase/`) — instance-local and gitignored, created by
the setup wizard.

Two pillars:

1. **Content & SEO engine** — turns the product's release cadence + a curated
   fact-base into changelog / blog / programmatic-SEO pages, committed into
   the product's website repo (which auto-deploys, e.g. on Vercel).
2. **Social posting** — regular, on-brand posts with UTM links so a UTM-aware
   analytics setup picks up attribution for free. Targets are configured per
   product (`socialTargets` in product.json); X stays disabled (paid API).

The engine lives **outside** the product on purpose: it may only touch the
GitHub API, the `claude` CLI, social platform APIs, and its own Postgres —
never the product's code or telemetry posture.

## Quickstart (guided)

```bash
git clone https://github.com/sjunnesson/growth-engine.git myapp-growth
cd myapp-growth
./deploy/build-menubar.sh          # requires Xcode Command Line Tools
open "deploy/build/Growth Engine.app"
```

The menu bar item knows nothing is configured and offers one action: **"Set
up growth engine…"** — it starts the dashboard (first launch installs
dependencies and builds it; give it a minute) and opens the guided Setup
page: prerequisite checks → point at your repo and notes → interview →
live drafting progress → a review checklist (env, database, dry-run) → your
sign-off. Add the app to Login Items; after onboarding, re-run
`./deploy/build-menubar.sh` to rename it for your product.

Not on macOS (or no menu bar wanted)? `npm run dev` and open
`http://127.0.0.1:3400/setup` — the same guided flow.

## Install with an AI agent (copy-paste prompt)

Launch an agentic coding assistant with shell access (e.g. Claude Code) in
the folder that contains your product's source repo and paste this:

```text
Set up growth-engine (https://github.com/sjunnesson/growth-engine), an
autonomous marketing engine, for the product whose source code is in or near
the current directory. Work step by step; verify each step before the next.

CONTEXT: growth-engine is a Next.js + Postgres app that generates
changelog/blog/SEO/social marketing copy for ONE product under strict
guardrails. One engine checkout serves one product; product-specific config
lives in its gitignored product/ dir, drafted by the onboarding wizard. AI
generation shells out to the Claude Code CLI ("claude -p") using the
machine's existing Claude auth — no API key. The engine is safe by default:
everything stays dry-run until the HUMAN reviews the generated fact base.

YOUR HARD LIMITS: never set DRY_RUN=false, never populate LIVE_CHANNELS,
never set "reviewed": true in product.json, never resolve TODO(verify)
markers in the generated fact base yourself, never publish anything. Those
are human-only actions.

STEPS
1. Survey the current directory and identify the product's source repo
   (may be the current dir or a subdirectory). Confirm your pick with me,
   and ask whether I have an Obsidian vault (or any markdown-notes folder)
   about the product worth mining; get its path.
2. Preflight — report anything missing and help me install it: git,
   Node.js 20+, npm; the "claude" CLI on PATH and authenticated (verify:
   claude -p "say ok" --model haiku); Postgres (existing server or Docker);
   macOS + Xcode Command Line Tools only if I want the menu bar scheduler.
3. Clone the engine NEXT TO the product repo (never inside it):
   git clone https://github.com/sjunnesson/growth-engine.git <slug>-growth
   Then npm install inside it, and read its README.md and SETUP.md — they
   add detail this prompt omits.
4. Interview me conversationally instead of running the interactive wizard
   (read the interview() function in scripts/setup.ts for the full question
   list): product name, slug, canonical domain, site URL, website GitHub
   repo (owner/repo) that content gets committed into, website branch,
   releases repo, content file format (json | markdown), release tag scheme
   (semver | any), social channels to target, CTA paths, EXACT allowed
   price tokens, pricing model in one or two sentences, competitor names
   never to characterize, and anything the copy must NEVER claim. Save my
   answers to answers.json.
5. Run the wizard non-interactively:
   npm run setup -- --repo <product-repo> [--vault <vault>] --answers answers.json
   It drafts product/ (config, fact base, guardrails, content plan) with
   reviewed:false.
6. Database: run `npm run db:local` — it provisions a private Postgres
   inside the checkout (.pgdata/), writes DATABASE_URL to .env.local, and
   applies the schema; it starts automatically whenever the engine runs.
   Only use an external Postgres if I ask for one. Then finish .env.local:
   a PORT no other engine instance on this machine uses (default 3400);
   DRY_RUN=true; LIVE_CHANNELS empty. Ask me for a fine-grained GitHub PAT
   (read on the releases repo, read+write on the website repo) for
   GITHUB_TOKEN; leave it blank if I don't have one yet.
7. npm run db:migrate, then npm run dryrun. Every guardrail self-test line
   must PASS; with a DB configured, every pipeline row must end dry_run.
8. If I'm on macOS and want the scheduler: ./deploy/build-menubar.sh, then
   tell me to open the app it built in deploy/build/ and add it to Login
   Items. Otherwise show me the manual tick: npm run once.
9. Hand off with a short report: what you set up, where, and my remaining
   HUMAN-ONLY checklist — (a) review product/factbase/facts.md (fix every
   TODO(verify), delete anything not literally true), banned-claims.json,
   and product.json; (b) npm run dev → the dashboard /setup page walks the
   rest (env, migrate, dry-run, sign-off); (c) go live gradually via
   LIVE_CHANNELS per SETUP.md.
```

## Onboarding a new product (CLI)

```bash
# a fresh checkout per product, then:
npm run setup -- --repo ~/code/yourapp --vault ~/Obsidian/YourVault
```

Same engine as the guided flow (`/setup` in the dashboard is the friendlier
front-end); `--answers file.json` makes it non-interactive for agents.

The wizard analyzes the repo (README, manifests, docs, release tags) and the
Obsidian vault (a triage pass picks the relevant notes) with the Claude CLI,
interviews you for what analysis can't infer (pricing tokens, domains, repos,
channels, never-claims), and drafts the full `product/` directory: config,
fact base, guardrail patterns, evergreen angles, SEO-page and comparison
briefs.

**Everything it writes is a draft.** `product.json` ships `reviewed: false`,
which forces every channel to dry-run regardless of `DRY_RUN`/`LIVE_CHANNELS`
until you review the fact base and sign off on the dashboard's Overview page.
The closed-world guarantee is that human review, not the wizard.

## Architecture

```
tick: poll releases ─┐
tick: social drip   ─┼─▶ post_queue (Postgres, dedupe_key UNIQUE)
tick: content sync  ─┘            │
                                  ▼
tick ──▶ kill-switch ▶ Claude generate ▶ normalize ▶ guardrails (lint + critic)
            │
            ├─ changelog             → auto-publish → GitHub commit → deploy
            └─ everything else       → status 'ready' ─▶ DASHBOARD (you approve)
              (blog/SEO/social/comparison)               └─▶ re-lint → publish
         ▶ audit_log (every transition)
```

- **Product config** (`lib/product.ts`): identity, repos, CTA paths, site
  layout (content dirs, URL paths, json or markdown-frontmatter files),
  release tag scheme, social targets, critic notes. Override the location
  with `PRODUCT_DIR`.
- **Channel registry** (`lib/channels.ts`): one declaration per channel —
  rate caps, char limits, approval lane, risk tier. Adding a channel is one
  entry here plus a client in `lib/social/`.
- **Guardrails**: deterministic lint (banned patterns = engine-generic
  `templates/banned-claims.base.json` merged with the product's
  `factbase/banned-claims.json`, price/version/link/emoji allowlists) then an
  LLM critic that fails closed.

**Approval (per-channel):** only changelog auto-publishes (release-notes-
derived, git-revertable). Blog posts, SEO pages, social posts, and comparison
pages stop at status `ready` and wait for approval in the local dashboard; on
approval the next tick re-runs the deterministic lint on the (possibly
edited) copy, then publishes.

Safety: the `reviewed` gate above, `GROWTH_HALT` env hard-stop, scoped DB
kill switch, `DRY_RUN` default, per-channel `LIVE_CHANNELS` rollout flags,
the approval gate, `dedupe_key UNIQUE` idempotency, per-channel rate limits,
deterministic lint + LLM critic, full append-only `audit_log`.

## Dashboard

Local, no auth, bound to `127.0.0.1` (port `PORT`, default 3400 — give each
engine instance its own):

```bash
npm run build && npm run dashboard   # http://127.0.0.1:3400
```

- **Overview** — posture, the factbase-review sign-off, per-channel
  kill-switch toggles (global > content/social > channel:*), queue counts.
- **Queue & approvals** — items awaiting your OK (editable copy + Approve /
  Reject), recent history with a `view ↗` link to the published artefact,
  Retry on failures/skips/dry-runs.
- **Cadence** — posting frequency per channel, cap budgets, what goes out
  next; tune the drip intervals.
- **Angles** — the evergreen rotation: add/remove angles that feed the blog +
  social drip.
- **Fact base** — edit the closed world (`product/factbase/facts.md`) with an
  automatic `FACTBASE_VERSION` bump on save.
- **Audit** — the append-only decision trail.

The dashboard only records intent in Postgres; the scheduled tick
(`npm run once` / the menu bar app) does the actual publishing.

**Menu bar app — this is also the scheduler:** `./deploy/build-menubar.sh`
builds "&lt;Product&gt; Marketing Engine.app" (name, bundle id, and glyph derive
from product.json) — a status item showing the last tick, a badge when items
await approval, ⚠︎ on failed/stalled ticks, and shortcuts to the dashboard, a
manual tick, and the runner log. It runs a tick whenever the last one is older
than 30 minutes (including catch-up after sleep). Add it to Login Items — the
engine ticks only while the app runs.

Why not launchd: a repo under `~/Documents` (TCC-protected) is silently
denied to background LaunchAgents (exit 126, no prompt), so
`deploy/install-launchd.sh` only works for checkouts outside protected
folders. A user-launched app has normal file access and its children inherit
it.

## Develop

```bash
npm install
cp .env.example .env.local      # fill DATABASE_URL (one DB per instance)
                                # (no ANTHROPIC_API_KEY — AI uses the `claude` CLI)
npm run db:migrate              # create tables + seed kill-switch scopes
npm run dev                     # http://127.0.0.1:3400
npm run dryrun                  # end-to-end dry-run smoke (no external writes)
```

Everything defaults to `DRY_RUN=true`, under which `LIVE_CHANNELS` is the
allow-list: a channel listed there publishes for real; everything else runs
the full pipeline but stops at a recorded dry-run. (`DRY_RUN=false` is the
global go-live and is not required for per-channel rollout.) An unreviewed
product overrides both — nothing publishes.

**AI runtime:** content/critic generation shells out to the Claude Code CLI
(`claude -p`), reusing your existing Claude auth instead of a metered API key.
The `claude` binary must be installed + authenticated where it runs, which
Vercel serverless can't do — so the engine runs as a **headless local tick**:

```bash
npm run once                 # one tick: enqueue (idempotent) + dispatch a batch
./deploy/build-menubar.sh    # build the scheduler app (see above)
```

Rate limits + per-period/slug/release dedupe keep volume correct no matter
how often the tick fires. Full local recipe (Postgres, scheduling) in
`SETUP.md §1.4`.

## Optional: Vercel cron routes (`vercel.json`)

The local tick is the production runtime. The HTTP cron routes
(`/api/cron/*`, schedules in `vercel.json`) remain only for an optional
Vercel deployment of the admin API — the AI-bearing routes fail there
(`claude` binary unavailable in serverless). If you never deploy this repo to
Vercel, ignore them.
