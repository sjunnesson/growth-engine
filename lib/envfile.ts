// Minimal .env.local editing, shared by the Setup UI and CLI helpers.
// Values are instance-local secrets — callers must never log them.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = () => resolve(process.cwd(), ".env.local");

export function readEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(FILE(), "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* absent = empty */
  }
  return out;
}

/** Create-or-update KEY=VALUE lines, preserving everything else. Also mirrors
 *  into process.env (except PORT, which only applies at boot) so the running
 *  dashboard sees the change without a restart. */
export function upsertEnvLocal(updates: Record<string, string>): void {
  let lines: string[];
  try {
    lines = readFileSync(FILE(), "utf-8").split("\n");
  } catch {
    lines = [
      "# Growth-engine instance env — created by setup.",
      "DRY_RUN=true",
      "LIVE_CHANNELS=",
    ];
  }
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const i = lines.findIndex((l) => l.startsWith(`${key}=`) || l.startsWith(`# ${key}=`));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
    if (key !== "PORT") process.env[key] = value;
  }
  writeFileSync(FILE(), lines.join("\n").replace(/\n*$/, "\n"));
}
