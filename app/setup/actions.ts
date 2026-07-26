"use server";

// Server actions for the guided Setup page. Everything here runs on the
// operator's own machine against the local checkout (the dashboard binds to
// 127.0.0.1) — the actions write instance-local files (.env.local, product/)
// and spawn local child processes; nothing leaves the machine.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  type Answers,
  finalizeAnswers,
  looksLikeRepo,
  repoCandidates,
  SETUP_STATUS_FILE,
} from "@/lib/setup";
import { createLocalDb, isManagedUrl } from "@/lib/localdb";
import { upsertEnvLocal } from "@/lib/envfile";
import { productOrNull } from "@/lib/product";

const ROOT = process.cwd();
const ANSWERS_FILE = ".setup-answers.json";
const SETUP_LOG = ".setup.log";
const DRYRUN_LOG = ".dryrun.log";

function fail(msg: string): never {
  redirect(`/setup?err=${encodeURIComponent(msg)}`);
}
function ok(msg: string): never {
  redirect(`/setup?msg=${encodeURIComponent(msg)}`);
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const list = (fd: FormData, k: string) =>
  s(fd, k)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Validate the form, persist answers, and launch the drafting run as a
 *  detached child (it takes minutes — the page polls the status file). */
export async function startSetupAction(formData: FormData) {
  const repo = resolve(s(formData, "repoPath"));
  const vault = s(formData, "vaultPath") ? resolve(s(formData, "vaultPath")) : "";

  if (!existsSync(repo) || !statSync(repo).isDirectory())
    fail(`Product repo path is not a directory: ${repo}`);
  if (!looksLikeRepo(repo)) {
    const c = repoCandidates(repo);
    fail(
      `${repo} doesn't look like a product source repo (no README, build manifest, Xcode project, or .git).` +
        (c.length ? ` It contains repos though — did you mean: ${c.join(", ")}?` : ""),
    );
  }
  if (vault && (!existsSync(vault) || !statSync(vault).isDirectory()))
    fail(`Vault path is not a directory: ${vault}`);

  let answers: Answers;
  try {
    answers = finalizeAnswers({
      name: s(formData, "name"),
      slug: s(formData, "slug"),
      domain: s(formData, "domain"),
      siteUrl: s(formData, "siteUrl"),
      websiteRepo: s(formData, "websiteRepo"),
      websiteBranch: s(formData, "websiteBranch") || "main",
      releasesRepo: s(formData, "releasesRepo"),
      format: s(formData, "format") as Answers["format"],
      tagScheme: s(formData, "tagScheme") as Answers["tagScheme"],
      socialTargets: list(formData, "socialTargets"),
      ctaRelease: s(formData, "ctaRelease") || "/",
      ctaSeo: s(formData, "ctaSeo") || s(formData, "ctaRelease") || "/",
      ctaComparison: s(formData, "ctaComparison") || "/",
      priceTokens: list(formData, "priceTokens"),
      pricingNotes: s(formData, "pricingNotes"),
      competitors: list(formData, "competitors"),
      neverClaim: s(formData, "neverClaim"),
    });
  } catch (e) {
    fail((e as Error).message);
  }

  writeFileSync(resolve(ROOT, ANSWERS_FILE), JSON.stringify(answers, null, 2) + "\n");

  // Detached child so the (minutes-long) drafting outlives this request.
  // Console output lands in .setup.log; progress lands in the status file.
  const log = openSync(resolve(ROOT, SETUP_LOG), "w");
  const child = spawn(
    process.execPath,
    [
      "--env-file-if-exists=.env.local",
      "--import",
      "tsx",
      "scripts/setup.ts",
      "--repo",
      repo,
      ...(vault ? ["--vault", vault] : []),
      "--answers",
      ANSWERS_FILE,
      "--status-file",
      SETUP_STATUS_FILE,
    ],
    { cwd: ROOT, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();

  // Seed the status file immediately so the page shows progress even before
  // the child's first write.
  writeFileSync(
    resolve(ROOT, SETUP_STATUS_FILE),
    JSON.stringify(
      {
        stage: "analyzing",
        detail: repo,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  revalidatePath("/setup");
  redirect("/setup");
}

/** Clear a failed run's status so the form shows again. */
export async function resetSetupAction() {
  try {
    writeFileSync(resolve(ROOT, SETUP_STATUS_FILE), "");
  } catch {
    /* fine */
  }
  revalidatePath("/setup");
  redirect("/setup");
}

// ---------------------------------------------------------------------------
// env + infra steps (review phase)

function migrate(): { ok: boolean; out: string } {
  const r = spawnSync(
    process.execPath,
    ["--env-file-if-exists=.env.local", "--import", "tsx", "lib/db/migrate.ts"],
    { cwd: ROOT, encoding: "utf-8", timeout: 90_000 },
  );
  return {
    ok: r.status === 0,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" · "),
  };
}

/** The stupid-simple database path: provision the private in-checkout
 *  Postgres (.pgdata), point DATABASE_URL at it, apply the schema. */
export async function createLocalDbAction() {
  // Belt to the UI's braces (the button only renders when no DB is set):
  // never replace an existing external database out from under an instance.
  const current = process.env.DATABASE_URL;
  if (current && !isManagedUrl(current))
    fail("this instance already has an external DATABASE_URL — remove it from .env.local first if you want the built-in local database");
  const slug = productOrNull()?.slug ?? "growth";
  let url = "";
  try {
    url = await createLocalDb(`${slug.replace(/-/g, "_")}_growth`);
  } catch (e) {
    fail(`could not create the local database: ${(e as Error).message}`);
  }
  upsertEnvLocal({ DATABASE_URL: url });
  const m = migrate();
  if (!m.ok) fail(`database created, but applying the schema failed — ${m.out}`);
  ok("local database ready — it lives in .pgdata/ and starts automatically whenever the engine runs");
}

export async function saveEnvAction(formData: FormData) {
  const updates: Record<string, string> = {};
  for (const key of ["DATABASE_URL", "PORT", "GITHUB_TOKEN"]) {
    const v = s(formData, key);
    if (v) updates[key] = v;
  }
  if (Object.keys(updates).length === 0) fail("nothing to save");
  upsertEnvLocal(updates);

  // A pasted DATABASE_URL should be usable immediately — apply the schema now.
  if (updates.DATABASE_URL) {
    const m = migrate();
    if (!m.ok) fail(`saved, but applying the schema failed — ${m.out}`);
    ok("database connected and schema applied");
  }
  ok(
    `saved ${Object.keys(updates).join(", ")} to .env.local` +
      (updates.PORT ? " — PORT takes effect on the next dashboard start" : ""),
  );
}

export async function migrateAction() {
  const m = migrate();
  if (m.ok) ok(`schema applied — ${m.out}`);
  fail(`schema apply failed — ${m.out || "no output"}`);
}

/** Full dry-run takes minutes (real generations) — detached, log-tailed. */
export async function dryrunAction() {
  const log = openSync(resolve(ROOT, DRYRUN_LOG), "w");
  const child = spawn(
    process.execPath,
    ["--env-file-if-exists=.env.local", "--import", "tsx", "scripts/dryrun.ts"],
    { cwd: ROOT, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  ok("dry-run started — output appears below (refresh to update)");
}
