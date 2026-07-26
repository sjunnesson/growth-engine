// Zero-setup local Postgres. The embedded-postgres npm package delivers real
// Postgres binaries into node_modules; this module drives initdb/pg_ctl
// directly so the server runs as a normal daemon that OUTLIVES whichever
// process started it (tick, dashboard, migrate are separate processes — the
// package's own managed lifecycle stops the server on process exit, which is
// the wrong shape here).
//
// Layout, all instance-local and gitignored:
//   .pgdata/data/         the cluster (initdb output)
//   .pgdata/postgres.log  server log
//   .pgdata/meta.json     { port, url } — marks the DATABASE_URL as "managed",
//                         which is what arms ensureLocalDb()'s auto-start.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, Socket } from "node:net";
import { resolve } from "node:path";
import postgres from "postgres";

const ROOT = process.cwd();
const PGDATA_ROOT = resolve(ROOT, ".pgdata");
const DATA_DIR = resolve(PGDATA_ROOT, "data");
const LOG_FILE = resolve(PGDATA_ROOT, "postgres.log");
const META_FILE = resolve(PGDATA_ROOT, "meta.json");
const USER = "growth";

interface LocalDbMeta {
  port: number;
  url: string;
}

function binDir(): string {
  const plat = `${process.platform}-${process.arch}`;
  const dir = resolve(ROOT, "node_modules", "@embedded-postgres", plat, "native", "bin");
  if (!existsSync(dir))
    throw new Error(
      `no bundled Postgres for ${plat} (expected ${dir}) — re-run npm install, or use your own Postgres via DATABASE_URL`,
    );
  return dir;
}

export function localDbMeta(): LocalDbMeta | null {
  try {
    return JSON.parse(readFileSync(META_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/** Is this DATABASE_URL the engine-managed local database? */
export function isManagedUrl(url: string | undefined): boolean {
  const meta = localDbMeta();
  return Boolean(url && meta && url === meta.url);
}

function probe(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((done) => {
    const s = new Socket();
    const finish = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once("error", () => finish(false));
    s.connect(port, "127.0.0.1", () => finish(true));
  });
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => done(port));
    });
  });
}

function pgCtlStart(port: number): void {
  execFileSync(resolve(binDir(), "pg_ctl"), [
    "-D",
    DATA_DIR,
    "-l",
    LOG_FILE,
    "-o",
    `-p ${port} -c listen_addresses=127.0.0.1`,
    "-w",
    "start",
  ], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
}

/**
 * One-click provisioning: initdb a private cluster inside the checkout,
 * start it, create the database, return the connection URL. Idempotent —
 * an existing managed cluster is just started + reused.
 */
export async function createLocalDb(dbName: string): Promise<string> {
  const existing = localDbMeta();
  if (existing) {
    if (!(await probe(existing.port))) pgCtlStart(existing.port);
    return existing.url;
  }

  const bins = binDir();
  const port = await freePort();
  const password = randomBytes(12).toString("hex");

  mkdirSync(PGDATA_ROOT, { recursive: true });
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true }); // half-finished prior attempt
  const pwfile = resolve(PGDATA_ROOT, ".pwfile");
  writeFileSync(pwfile, password + "\n", { mode: 0o600 });
  try {
    execFileSync(resolve(bins, "initdb"), [
      "-D",
      DATA_DIR,
      "-U",
      USER,
      "--pwfile",
      pwfile,
      "-A",
      "scram-sha-256",
      "-E",
      "UTF8",
    ], { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } finally {
    rmSync(pwfile, { force: true });
  }

  pgCtlStart(port);

  // No createdb binary in the bundle — create the database over the wire.
  const admin = postgres(`postgres://${USER}:${password}@127.0.0.1:${port}/postgres`, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName.replace(/[^a-z0-9_]/g, "_")}"`);
  } catch (e) {
    if ((e as { code?: string }).code !== "42P04") throw e; // 42P04 = already exists
  } finally {
    await admin.end();
  }

  const url = `postgres://${USER}:${password}@127.0.0.1:${port}/${dbName.replace(/[^a-z0-9_]/g, "_")}`;
  writeFileSync(META_FILE, JSON.stringify({ port, url }, null, 2) + "\n", { mode: 0o600 });
  return url;
}

/**
 * Called by every entrypoint that touches the DB (dashboard boot, tick,
 * migrate, dryrun, seed): when DATABASE_URL is the managed local database
 * and its server isn't running (reboot, first use), start it. No-op for
 * external databases.
 */
export async function ensureLocalDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const meta = localDbMeta();
  if (!url || !meta || url !== meta.url) return;
  if (await probe(meta.port)) return;
  try {
    pgCtlStart(meta.port);
  } catch (e) {
    throw new Error(
      `could not start the local database (.pgdata) — see ${LOG_FILE}: ${(e as Error).message}`,
    );
  }
  if (!(await probe(meta.port, 2_000)))
    throw new Error(`local database started but not reachable on 127.0.0.1:${meta.port} — see ${LOG_FILE}`);
}
