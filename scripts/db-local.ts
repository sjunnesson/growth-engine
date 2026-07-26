/**
 * One-command local database: `npm run db:local`.
 *
 * Provisions the private in-checkout Postgres (.pgdata/, nothing to install),
 * writes DATABASE_URL to .env.local, and applies the schema. Idempotent —
 * re-running just makes sure the server is up. The Setup page's "Create a
 * local database for me" button does exactly this.
 */
import { execFileSync } from "node:child_process";
import { createLocalDb, isManagedUrl } from "@/lib/localdb";
import { upsertEnvLocal } from "@/lib/envfile";
import { productOrNull } from "@/lib/product";

async function main() {
  // Never clobber a configured instance: an existing external DATABASE_URL
  // means this checkout already has a database with live dedupe/audit state.
  const current = process.env.DATABASE_URL;
  if (current && !isManagedUrl(current)) {
    console.error(
      "[db:local] DATABASE_URL is already set to an external database — refusing to replace it.\n" +
        "           Remove it from .env.local first if you really want the built-in local database.",
    );
    process.exit(1);
  }
  const slug = productOrNull()?.slug ?? "growth";
  const dbName = `${slug.replace(/-/g, "_")}_growth`;
  console.log(`[db:local] provisioning private Postgres (.pgdata) with database "${dbName}" ...`);
  const url = await createLocalDb(dbName);
  upsertEnvLocal({ DATABASE_URL: url });
  console.log("[db:local] DATABASE_URL written to .env.local");
  console.log("[db:local] applying schema ...");
  execFileSync(
    process.execPath,
    ["--env-file-if-exists=.env.local", "--import", "tsx", "lib/db/migrate.ts"],
    { stdio: "inherit", timeout: 90_000 },
  );
  console.log("[db:local] done — the database starts automatically whenever the engine runs.");
}

main().catch((e) => {
  console.error(`[db:local] FATAL: ${(e as Error).message}`);
  process.exit(1);
});
