// Read + save the fact base (product/factbase/facts.md) from the dashboard.
// The fact base is the closed world: every edit MUST bump FACTBASE_VERSION
// (prompt-cache key, recorded on every generated row). Saving here bumps it
// automatically unless the editor already changed the version line.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { productDir } from "@/lib/product";

const FILE = () => resolve(productDir(), "factbase", "facts.md");
const VERSION_RE = /FACTBASE_VERSION:\s*([^\s]+)/;

export function readFactsRaw(): { text: string; version: string } {
  const text = readFileSync(FILE(), "utf-8");
  return { text, version: text.match(VERSION_RE)?.[1] ?? "unknown" };
}

function nextVersion(current: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const m = current.match(/^(\d{4}-\d{2}-\d{2})\.(\d+)$/);
  if (m && m[1] === today) return `${today}.${Number(m[2]) + 1}`;
  return `${today}.1`;
}

export function saveFacts(text: string): {
  ok: boolean;
  message: string;
  oldVersion?: string;
  newVersion?: string;
} {
  const trimmed = text.replace(/\r\n/g, "\n");
  if (trimmed.trim().length < 200)
    return { ok: false, message: "fact base suspiciously short — refusing to save" };
  const submittedVersion = trimmed.match(VERSION_RE)?.[1];
  if (!submittedVersion)
    return { ok: false, message: "FACTBASE_VERSION line is missing — it is required" };

  const current = readFactsRaw();
  if (trimmed === current.text)
    return { ok: false, message: "no changes to save" };

  // Auto-bump unless the editor bumped it manually.
  let out = trimmed;
  let version = submittedVersion;
  if (submittedVersion === current.version) {
    version = nextVersion(current.version);
    out = trimmed.replace(VERSION_RE, `FACTBASE_VERSION: ${version}`);
  }

  writeFileSync(FILE(), out.endsWith("\n") ? out : out + "\n");
  return {
    ok: true,
    message: `saved — version ${current.version} → ${version}`,
    oldVersion: current.version,
    newVersion: version,
  };
}
