// Operator-tunable engine settings, stored one jsonb value per key in the
// `settings` table. Only the drip cadence lives here for now. The hard
// per-day/per-hour caps in lib/ratelimit.ts are deliberately NOT settings:
// they are the safety ceiling above whatever cadence is configured.
import { sql } from "@/lib/db/client";
import { jsonb } from "@/lib/db/client";
import { audit } from "@/lib/audit";

export interface CadenceSettings {
  socialIntervalDays: number; // one evergreen angle per social channel per N days
  blogIntervalDays: number; // blog rotates to a new angle every N days
}

export const CADENCE_DEFAULTS: CadenceSettings = {
  socialIntervalDays: 7,
  blogIntervalDays: 7,
};

const MIN_INTERVAL_DAYS = 1;
const MAX_INTERVAL_DAYS = 90;

function clampInterval(n: unknown, fallback: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_INTERVAL_DAYS, v));
}

/**
 * Never throws: cadence is not safety-critical (caps + approval still gate
 * everything), so a missing table or unreachable row must not stall a tick —
 * fall back to defaults instead.
 */
export async function getCadenceSettings(): Promise<CadenceSettings> {
  try {
    const [row] = await sql<{ value: Partial<CadenceSettings> }[]>`
      SELECT value FROM settings WHERE key = 'cadence'`;
    const v = row?.value ?? {};
    return {
      socialIntervalDays: clampInterval(
        v.socialIntervalDays,
        CADENCE_DEFAULTS.socialIntervalDays,
      ),
      blogIntervalDays: clampInterval(
        v.blogIntervalDays,
        CADENCE_DEFAULTS.blogIntervalDays,
      ),
    };
  } catch {
    return { ...CADENCE_DEFAULTS };
  }
}

export async function setCadenceSettings(
  input: Partial<CadenceSettings>,
): Promise<{ ok: boolean; message: string }> {
  const prev = await getCadenceSettings();
  const next: CadenceSettings = {
    socialIntervalDays: clampInterval(
      input.socialIntervalDays,
      prev.socialIntervalDays,
    ),
    blogIntervalDays: clampInterval(input.blogIntervalDays, prev.blogIntervalDays),
  };
  await sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('cadence', ${jsonb(next)}, now())
    ON CONFLICT (key) DO UPDATE SET value = ${jsonb(next)}, updated_at = now()`;
  await audit("dashboard", "cadence_updated", { prev, next }, { level: "warn" });
  return {
    ok: true,
    message: `Cadence saved — social every ${next.socialIntervalDays}d, blog every ${next.blogIntervalDays}d.`,
  };
}
