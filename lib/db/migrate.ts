// Idempotent migration runner. `npm run db:migrate`.
// schema.sql is written to be safe to apply repeatedly.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@/lib/db/client";
import { killSwitchScopes } from "@/lib/channels";
import { ensureLocalDb } from "@/lib/localdb";

async function main() {
  await ensureLocalDb();
  const here = dirname(fileURLToPath(import.meta.url));
  const ddl = readFileSync(resolve(here, "schema.sql"), "utf-8");
  console.log("[migrate] applying schema.sql ...");
  await sql.unsafe(ddl);
  // Seed kill-switch scopes from the channel registry (enabled) so every
  // channel shows up in /api/admin/status and gets a dashboard toggle.
  for (const scope of killSwitchScopes()) {
    await sql`
      INSERT INTO kill_switch (scope, enabled) VALUES (${scope}, true)
      ON CONFLICT (scope) DO NOTHING`;
  }
  console.log("[migrate] done");
  await sql.end();
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
