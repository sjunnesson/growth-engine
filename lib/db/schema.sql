-- Growth-engine schema. Idempotent: safe to run repeatedly (migrate.ts).
-- One Postgres per engine instance (one product), owned by this engine only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The work queue. dedupe_key UNIQUE is the core idempotency guarantee:
-- a retried cron / concurrent invocation can never enqueue or publish twice.
CREATE TABLE IF NOT EXISTS post_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel        text NOT NULL,            -- mastodon|bluesky|linkedin|reddit|x|changelog|blog|seo
  source_kind    text NOT NULL,            -- release|evergreen|comparison|seo
  dedupe_key     text NOT NULL UNIQUE,     -- e.g. release:v0.4.0:mastodon
  status         text NOT NULL DEFAULT 'pending',
                 -- pending|generating|ready|publishing|published|skipped|failed|dry_run
  scheduled_for  timestamptz NOT NULL DEFAULT now(),
  payload_in     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- inputs (release tag, angle id, factbase ver)
  generated_text text,
  generated_meta jsonb,                    -- model, tokens, cache hits, guardrail verdicts
  external_id    text,                     -- platform post id / git commit sha
  utm            text,                     -- exact UTM query string used
  attempts       int NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_queue_due_idx
  ON post_queue (status, scheduled_for);

-- Append-only forensic trail. Combined with the website repo's git history
-- this is the complete record of what the engine generated + published, and why.
CREATE TABLE IF NOT EXISTS audit_log (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,                 -- cron job / admin
  action    text NOT NULL,
            -- enqueue|generate|guardrail_pass|guardrail_block|publish|skip
            -- |killswitch_abort|rate_limited|error|dry_run
  queue_id  uuid REFERENCES post_queue (id) ON DELETE SET NULL,
  level     text NOT NULL DEFAULT 'info',  -- info|warn|error
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_queue_idx ON audit_log (queue_id);

-- Per-channel / per-window counters. Hard caps live in code; this is state.
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket       text PRIMARY KEY,           -- e.g. mastodon:day:2026-05-16
  window_start timestamptz NOT NULL,
  count        int NOT NULL DEFAULT 0
);

-- Operator-tunable engine settings (e.g. drip cadence), one jsonb value per
-- key. Defaults live in code (lib/settings.ts): absent key == defaults.
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Scoped kill switches. enabled=false => that scope is HALTED.
-- Rows are upserted by admin endpoint; absence => allowed (fail-open per scope,
-- but the global GROWTH_HALT env is fail-closed defense-in-depth).
CREATE TABLE IF NOT EXISTS kill_switch (
  scope      text PRIMARY KEY,             -- global|content|social|channel:<x>
  enabled    boolean NOT NULL DEFAULT true,
  reason     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Scope rows are seeded by migrate.ts from the channel registry
-- (lib/channels.ts killSwitchScopes) so every channel gets a dashboard toggle.
