// Read + mutate the evergreen angle list (product/factbase/social-evergreen.json)
// from the dashboard. Angles are briefs, not copy and not facts — editing
// them does NOT require a FACTBASE_VERSION bump (that applies to
// facts.md, the closed world for claims).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { productDir } from "@/lib/product";
import { loadBanned, type EvergreenAngle } from "@/lib/sources/factbase";

const FILE = () => resolve(productDir(), "factbase", "social-evergreen.json");

export interface AngleInput {
  id: string;
  brief: string;
  cta: string;
}

export function addAngle(input: AngleInput): { ok: boolean; message: string } {
  const id = input.id.trim().toLowerCase();
  const brief = input.brief.trim();
  const cta = input.cta.trim();

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))
    return { ok: false, message: "id must be kebab-case (letters, digits, hyphens)" };
  if (brief.length < 20 || brief.length > 400)
    return { ok: false, message: "brief must be 20–400 characters" };
  if (brief.includes("—"))
    return { ok: false, message: "no em dashes (house style; the model mirrors briefs)" };
  // Same domain allowlist lint enforces on generated copy — one authority.
  const allowed = loadBanned().allowedDomains;
  let host = "";
  try {
    host = new URL(cta).host;
  } catch {
    return { ok: false, message: "cta must be a full URL (https://...)" };
  }
  if (!allowed.some((d) => host === d || host.endsWith("." + d)))
    return { ok: false, message: `cta host must be one of: ${allowed.join(", ")}` };

  const raw = JSON.parse(readFileSync(FILE(), "utf-8")) as {
    _comment?: string;
    angles: EvergreenAngle[];
  };
  if (raw.angles.some((a) => a.id === id))
    return { ok: false, message: `angle "${id}" already exists` };

  raw.angles.push({ id, brief, cta });
  writeFileSync(FILE(), JSON.stringify(raw, null, 2) + "\n");
  return { ok: true, message: `angle "${id}" added (${raw.angles.length} total)` };
}

export function removeAngle(id: string): { ok: boolean; message: string } {
  const raw = JSON.parse(readFileSync(FILE(), "utf-8")) as {
    _comment?: string;
    angles: EvergreenAngle[];
  };
  if (!raw.angles.some((a) => a.id === id))
    return { ok: false, message: `angle "${id}" not found` };
  if (raw.angles.length === 1)
    return {
      ok: false,
      message: "cannot remove the last angle — the drip rotation needs at least one",
    };
  raw.angles = raw.angles.filter((a) => a.id !== id);
  writeFileSync(FILE(), JSON.stringify(raw, null, 2) + "\n");
  return { ok: true, message: `angle "${id}" removed (${raw.angles.length} remaining). Already-published posts stay live.` };
}
