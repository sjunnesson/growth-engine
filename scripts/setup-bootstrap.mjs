#!/usr/bin/env node
// Dependency-free bootstrap for `npm run setup`. On a fresh clone there is no
// node_modules yet, and loading tsx directly dies at Node startup with an
// unhelpful ERR_MODULE_NOT_FOUND — so install dependencies first if they are
// missing, then hand off to the real wizard (scripts/setup.ts).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(resolve(root, "node_modules", "tsx"))) {
  console.log("[setup] first run — installing dependencies (npm install) ...");
  const i = spawnSync("npm", ["install"], { cwd: root, stdio: "inherit" });
  if (i.status !== 0) {
    console.error("[setup] npm install failed — fix that first, then re-run.");
    process.exit(i.status ?? 1);
  }
}

const r = spawnSync(
  process.execPath,
  [
    "--env-file-if-exists=.env.local",
    "--import",
    "tsx",
    "scripts/setup.ts",
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit" },
);
process.exit(r.status ?? 0);
