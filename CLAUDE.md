# CLAUDE.md

Guidance for Claude Code working in the **growth-engine** repo
(github.com/sjunnesson/growth-engine, public).

## What this is

A product-agnostic autonomous marketing engine. One checkout serves ONE
product; everything product-specific lives in `product/` (`product.json` +
`factbase/`), which is **instance-local and gitignored** — created by
`npm run setup`, never committed here. This repo is PUBLIC: no secrets,
tokens, product fact bases, or non-public product information may ever be
committed. Secrets live only in the gitignored `.env.local`; product data
lives only in the gitignored `product/`.

## Hard rules

- **The engine stays product-agnostic.** No product-specific strings in
  `lib/`, `app/`, `scripts/`, or `deploy/` — they belong in `product/` (or
  `templates/` if they apply to every product). Grep for the product name
  before committing.
- **The product stays zero-telemetry.** Nothing here may add tracking,
  telemetry, or network calls to the target product. This engine only
  touches: GitHub API, the `claude` CLI, social platform APIs, its own
  Postgres.
- **Closed-world content.** Generated copy may only assert facts present in
  `product/factbase/facts.md` (and verbatim release notes). Never invent
  prices, dates, versions, metrics, or competitor claims. Pricing/version
  tokens in output must match the fact-base exactly — enforced by
  `lib/guardrails/lint.ts` (engine-generic patterns merge in from
  `templates/banned-claims.base.json`).
- **Safety first.** Every tick/cron path must: check `GROWTH_HALT`, then the
  scoped kill switch, before doing anything. Every state transition writes to
  `audit_log`. Publishing is gated by the product's `reviewed` flag (false ⇒
  everything dry-runs), then `DRY_RUN` + `LIVE_CHANNELS`, and every channel
  except changelog additionally requires dashboard approval.
- **Static site is sacred.** The target website must keep its static export.
  This engine delivers content by committing files into that repo, never by
  adding a runtime to it.

## Tech

- Next.js 16 App Router, **Node runtime** (not static export).
- Postgres via the `postgres` package (`DATABASE_URL`, one DB per instance).
- AI via the **Claude Code CLI** (`claude -p --output-format json`), spawned
  in `lib/claude/cli.ts` — generation (Sonnet) + critic (Haiku), fact-base
  prepended as the system prefix. No `@anthropic-ai/sdk`, no API key here;
  the CLI uses its own auth. Requires the `claude` binary in the runtime
  (NOT Vercel serverless — see README "AI runtime" / SETUP.md).
- `@octokit/rest` for releases (read) + website commits (write).
- Social clients are hand-rolled `fetch` against each platform API (owned
  tooling, no paid marketing SaaS, no per-platform SDK).

## Commands

- `npm run dev` — dev server on :3400 (`PORT` overrides)
- `npm run db:migrate` — apply `lib/db/schema.sql` + seed kill-switch scopes
- `npm run dryrun` — full pipeline, no external writes
- `npm run setup -- --repo <path> [--vault <path>]` — onboard a new product
  (drafts `product/`; ships `reviewed:false` so nothing can publish)
- `npm run typecheck` — `tsc --noEmit`

## Layout

```
product/{product.json,factbase/*}      ← ALL product-specific data (gitignored, per instance)
templates/*                            ← engine-owned generation/guardrail templates
app/api/cron/{poll-releases,content-sync,social-drip,dispatch}/route.ts
app/api/admin/{kill,status}/route.ts
lib/db/{client,schema.sql,migrate}.ts
lib/{product,channels,killswitch,audit,ratelimit,cadence,settings,dedupe,env}.ts
lib/claude/{cli,generate,prompts,cache}.ts
lib/guardrails/{lint,critic,normalize}.ts
lib/sources/{releases,factbase}.ts
lib/content/{render,changelog,blog,seo}.ts
lib/social/{index,mastodon,bluesky,linkedin,reddit,x,utm}.ts
lib/github/{octokit,commit}.ts
scripts/{run,setup,dryrun,seed,probe-ai,promote-dryrun}.ts
```
