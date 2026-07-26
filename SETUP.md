# growth-engine — Setup & Verification Runbook

This engine is fully autonomous once live. Provision it carefully, verify each
gate in dry-run, then flip channels live one at a time.

---

## 0. Onboarding a product (new instances)

One checkout = one product. The guided path (macOS): build + open the menu
bar app and follow its "Set up growth engine…" flow — see README
"Quickstart". Headless/CLI path:

```bash
npm run setup -- --repo <product-repo-path> [--vault <obsidian-vault-path>]
```

Either way the wizard analyzes the repo + vault via the `claude` CLI,
interviews you for pricing tokens / domains / repos / channels, and drafts
`product/` (product.json + the whole factbase). It writes `reviewed: false`,
which forces every channel to dry-run until you review the drafts and sign
off (the dashboard `/setup` page walks the review: env, migrate, dry-run,
sign-off). Resolve every `TODO(verify)` in `product/factbase/facts.md`
before signing off — the closed-world guarantee is that review.

Give each instance its own `DATABASE_URL` (dedupe keys, rate buckets, and
kill switches are global within a database) and its own `PORT`.

`product/` is instance-local and gitignored — it never gets committed to this
repo. To version it, `git init` inside `product/` and push to a private repo.

---

## 1. External provisioning (you must do these — they need your accounts)

### 1.1 GitHub access
Create a **fine-grained PAT or GitHub App token** scoped to the two repos in
`product.json`:
- the releases repo (`github.releasesRepo`) → Contents: **Read** (read
  release notes)
- the website repo (`github.websiteRepo`) → Contents: **Read & write**
  (commit generated content; the push triggers the site's auto-deploy)

A GitHub App is preferred (scoped, rotatable, auditable). Put the token in
`GITHUB_TOKEN`.

### 1.2 Database — zero setup by default
You don't need to install anything: the engine can run a private Postgres
inside the checkout (`.pgdata/`, real Postgres binaries shipped via npm).
Either click **"Create a local database for me"** on the dashboard Setup
page, or:

```bash
npm run db:local     # provision .pgdata, write DATABASE_URL, apply schema
```

It starts automatically whenever the engine runs (dashboard boot, every
tick). Prefer your own Postgres (local server / Neon / Docker)? Put its
connection string in `DATABASE_URL` and run `npm run db:migrate` — one
database per engine instance either way.

### 1.3 AI — Claude Code CLI (no API key)
Generation + critic shell out to `claude -p`, reusing existing Claude auth.
No `ANTHROPIC_API_KEY` is required. On whatever host runs the AI crons:
- install Claude Code, and
- authenticate it: `claude login` (subscription) **or** set
  `CLAUDE_CODE_OAUTH_TOKEN` (for CI/headless) in that host's environment.

Models default to `sonnet` (generation) and `haiku` (critic); override with
`CLAUDE_GEN_MODEL` / `CLAUDE_CRITIC_MODEL`. Sanity check: `claude -p "ok" --model haiku`.

### 1.4 AI runtime — run on this Mac (chosen path)

`claude -p` needs the `claude` binary + auth in-process, which Vercel
serverless lacks. The engine runs here instead, as a headless tick
(`npm run once`) scheduled by launchd. No Vercel project, no HTTP routes, no
`CRON_SECRET` needed for normal operation.

```bash
# 1. config
cd growth-engine
cp .env.example .env.local
#   set GITHUB_TOKEN (for release polling + committing content to the website repo)
#   leave DRY_RUN=true and LIVE_CHANNELS empty for now
npm install

# 2. database — the built-in local Postgres (or set DATABASE_URL yourself)
npm run db:local

# 3. confirm this host can do the AI + a real tick (still dry-run)
npm run probe          # one real `claude -p` generation + lint, no DB
npm run once           # one full tick: enqueue + dispatch (all dry_run)

# 4. the dashboard — review/approve, kill switches, audit (localhost, no auth)
npm run build && npm run dashboard     # http://127.0.0.1:3400

# 5. schedule the tick: build + launch the menu bar app (also the scheduler).
#    Its name derives from product.json ("<Product> Marketing Engine.app").
./deploy/build-menubar.sh
open deploy/build/*.app        # add it to Login Items too
tail -f .runner.log
```

> Why not launchd: with the repo under `~/Documents` (TCC-protected), macOS
> silently denies background LaunchAgents file access (exit 126) — the
> menu bar app schedules ticks instead and has normal file access.
> `deploy/install-launchd.sh` remains only for repos outside protected
> folders; uninstall a stale agent with `./deploy/install-launchd.sh
> --uninstall`.

**The approval loop:** only changelog auto-publishes (release-notes-derived,
git-revertable). Social posts, blog posts, SEO pages, and comparison pages
land at status `ready` and wait in the dashboard ("Queue & approvals") — you
can edit the copy, then Approve or Reject. The *next* tick re-lints the
approved (possibly edited) text and publishes it; a bad edit is blocked,
never posted. Run the dashboard whenever you want to review; the tick keeps
running headless via launchd regardless.

The tick is idempotent (dedupe keys) and safe by default — it keeps producing
`dry_run` rows until you set `LIVE_CHANNELS` (and the high-risk gate) per the
rollout table below. Uninstall anytime:
`./deploy/install-launchd.sh --uninstall`.

> Caveat: a `StartInterval` LaunchAgent only fires while you're logged in, and
> a missed interval (laptop asleep) runs once on wake — fine for a content/
> social drip. The kill switch still works: `GROWTH_HALT=1` in `.env.local`,
> or the admin DB row, halts the next tick.

The Postgres store and the GitHub-commit step run right here too. A Vercel
project is now **optional** — only useful if you want `/api/admin/*` reachable
remotely (§1.5).

### 1.5 Vercel project (optional — admin/DB host only)
- If you keep a Vercel project for `/api/admin/*`: create it separate from
  the website project, add the env vars, set `CRON_SECRET`/`ADMIN_TOKEN`.
- `vercel.json` still defines the cron entries, but the AI crons there will
  fail with "`claude` not found" until moved to a Claude-capable host (above).
- **Leave `DRY_RUN=true` and `LIVE_CHANNELS` empty for initial deploy.**

### 1.5 Social tokens (Phase 3 only — leave blank until then)
- **Mastodon:** create an app on your instance → `MASTODON_BASE_URL`,
  `MASTODON_ACCESS_TOKEN`.
- **Bluesky:** create an app password → `BLUESKY_IDENTIFIER`,
  `BLUESKY_APP_PASSWORD`.
- **LinkedIn / Reddit:** later phases (OAuth onboarding).
- **X:** intentionally disabled (paid API). The client throws until you
  implement + opt in.

---

## 2. Rollout (flip safety off gradually)

| Phase | Action | Env |
|---|---|---|
| 0 | Deploy, migrate, observe crons enqueue + dry-run | `DRY_RUN=true`, `LIVE_CHANNELS=` |
| 1 | Go live for content only | `LIVE_CHANNELS=changelog,blog,seo` |
| 2 | Add comparison pages (highest-risk content) | add `comparison` to `LIVE_CHANNELS` |
| 3a | Social live: Mastodon + Bluesky | add `mastodon,bluesky` |
| 3b | Then LinkedIn, then Reddit (most conservative) | add `linkedin`, later `reddit` |

`DRY_RUN` stays `true` the whole time — `LIVE_CHANNELS` is the allow-list of
channels permitted to actually publish. (`DRY_RUN=false` is a global go-live;
high-risk `comparison`/`reddit` still require explicit listing.)

**Kill everything instantly:** set env `GROWTH_HALT=1` (hard stop, checked
before the DB), or `POST /api/admin/kill {"scope":"global","enabled":false}`.

---

## 3. Verification runbook (the 6 drills from the plan)

Local prep: `cp .env.example .env.local`, fill `DATABASE_URL`,
`CRON_SECRET`, `ADMIN_TOKEN`; ensure `claude` is logged in
(`claude -p "ok"`); `npm run db:migrate`.

### Drill 1 — Dry-run smoke (no external writes)
```bash
npm run dryrun
```
Expect: the deterministic guardrail self-test prints `[PASS]` for every
fixture (fixtures derive from THIS product's factbase: an invented price in
the product's currency, a hype phrase, extra/foreign link, missing link,
emoji overflow all BLOCK; clean copy passes). With DB set, it also enqueues a
batch and drains it — every row ends `dry_run` and `audit_log` shows
`generate → guardrail_pass → dry_run` with the would-be payload, and **zero**
external calls. The script exits non-zero if the guardrail invariant ever
fails.

### Drill 2 — Blog deploy proof (Phase 1)
Set `LIVE_CHANNELS=changelog,blog,seo`, hit (with the cron secret):
```bash
curl -H "Authorization: Bearer $CRON_SECRET" $URL/api/cron/content-sync
curl -H "Authorization: Bearer $CRON_SECRET" $URL/api/cron/dispatch
```
Expect: an engine commit in the website repo's history (authored as the PAT
owner, tagged `[<slug>-growth]` in the message — a synthetic bot author would
be refused deployment by Vercel Hobby); note blog/SEO items wait for
dashboard approval first, changelog commits directly; the site rebuilds;
`/changelog/<tag>` (or `/blog/<slug>`) renders on-brand; the URL appears in
the site's `sitemap.xml` / `feed.xml` if it exports them. **Rollback test:**
`git revert` the bot commit → site returns to prior state on redeploy.

### Drill 3 — Social proof (Phase 3)
Add `mastodon` to `LIVE_CHANNELS`, run `social-drip` then `dispatch`. Expect:
the post on the Mastodon account; `post_queue` row `published` with
`external_id`; **re-run `dispatch`** → no duplicate (dedupe), `audit_log`
shows the skip.

### Drill 4 — UTM attribution proof
Click the live post's link. In your site's UTM-aware analytics (e.g. Umami)
confirm a referral with `utm_source`, `utm_medium=social`, `utm_campaign`,
and `utm_content=<dedupe_key>`. Reconcile `utm_content` back to the
`post_queue` row. No website change was needed for this.

### Drill 5 — Kill-switch drill
```bash
curl -XPOST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"scope":"social","enabled":false}' $URL/api/admin/kill
```
Run all crons. Expect: zero social posts, `audit_log` `killswitch_abort`
entries; content crons still publish. Then `scope:"global"` halts everything.
Re-enable with `{"enabled":true}`.

### Drill 6 — Rate-limit drill
Enqueue >3 social items for one channel in a day (re-run `social-drip` /
seed rows), run `dispatch` repeatedly. Expect: only the cap publishes
(Mastodon ≤3/day, ≤1/hr — see `lib/ratelimit.ts`); the rest get
`rate_limited` in `audit_log` and are requeued for the next window.

### Health check anytime
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" $URL/api/admin/status
```
Returns posture (dryRun, liveChannels, growthHalt, factbase version, models),
kill switches, queue counts by status, and the last 25 audit rows.

---

## 4. Operating notes

- **Seeding an angle out of rotation:** `npm run seed -- <channel> <angleId>`
  (channels: blog + the social targets) enqueues that angle NOW instead of
  waiting for the drip rotation — for launches/announcements. All gates
  (lint, critic, dry-run posture, approval, rate limits) still apply.
- **Promoting dry-run content after go-live:** `dry_run` is terminal. Once a
  channel is in `LIVE_CHANNELS`, use the Retry button on the dashboard's
  Recent list to re-queue a dry-run row for real publication.
- **Editing facts:** change `product/factbase/facts.md` and **bump
  `FACTBASE_VERSION`** (the dashboard Fact base page does this on save). It is
  embedded in the system prefix and recorded on every generated row, so stale
  facts can't survive a bump.
- **Adding an SEO/comparison page:** add an entry to
  `product/factbase/seo-pages.json` / `comparisons.json`. `content-sync`
  picks it up; the slug dedupe means existing pages aren't regenerated.
- **Patch-release noise:** `lib/sources/releases.ts` collapses patch releases
  — every release still gets a changelog entry, but social posts only fire on
  minor/major bumps or a ≥3-patch rollup.
- **Audit trail = git + DB:** the website repo's commit history is the
  content trail (revertable); `audit_log` is the decision trail (every
  generate/guardrail/publish/skip).
