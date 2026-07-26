import postgres from "postgres";
import { env } from "@/lib/env";

// Single shared connection. `postgres` pools internally and is serverless-safe;
// keep one instance per warm lambda via globalThis to avoid connection storms.
declare global {
  // eslint-disable-next-line no-var
  var __growthEngineSql: ReturnType<typeof postgres> | undefined;
}

type Sql = ReturnType<typeof postgres>;

// Lazily constructed on first DB use. This keeps `next build` from requiring
// DATABASE_URL (route handlers are force-dynamic and touch the DB only at
// request time) while still enforcing the env var at runtime.
function init(): Sql {
  if (globalThis.__growthEngineSql) return globalThis.__growthEngineSql;
  const s = postgres(env.databaseUrl(), {
    max: 3,
    idle_timeout: 20,
    prepare: false, // friendlier to pgbouncer / serverless poolers
  });
  globalThis.__growthEngineSql = s;
  return s;
}

// Transparent lazy proxy: behaves exactly like the postgres tagged-template
// (`sql\`...\``) and exposes its methods (`sql.json`, `sql.unsafe`, `sql.end`),
// but defers connecting until the first call.
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  apply(_t, _this, args: unknown[]) {
    return (init() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_t, prop: string | symbol) {
    const s = init() as unknown as Record<string | symbol, unknown>;
    const v = s[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
  },
});

/**
 * jsonb column helper. `postgres`'s sql.json() has a very strict JSONValue
 * type; our payloads are plain serializable objects, so cast through here in
 * one place rather than scattering casts.
 */
export function jsonb(value: unknown) {
  return sql.json(value as never);
}

export type QueueStatus =
  | "pending"
  | "generating"
  | "ready"
  | "approved"
  | "publishing"
  | "published"
  | "skipped"
  | "failed"
  | "dry_run";

export interface QueueRow {
  id: string;
  channel: string;
  source_kind: string;
  dedupe_key: string;
  status: QueueStatus;
  scheduled_for: Date;
  payload_in: Record<string, unknown>;
  generated_text: string | null;
  generated_meta: Record<string, unknown> | null;
  external_id: string | null;
  utm: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}
