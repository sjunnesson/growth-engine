import { env } from "@/lib/env";
import { loadFacts } from "@/lib/sources/factbase";
import { product } from "@/lib/product";
import { runClaude } from "@/lib/claude/cli";

export interface CriticResult {
  verdict: "pass" | "block";
  reason: string;
  model: string;
}

/**
 * Cheap second opinion via `claude -p` (Haiku by default). Runs AFTER the
 * deterministic lint passes. Catches subtler issues: off-brand tone,
 * implied-but-unstated false claims, competitor characterization, hype.
 * Fails CLOSED on any error (including `claude` missing / unauthenticated).
 */
export async function critic(
  text: string,
  context: string,
  releaseNotes?: string,
  releaseTag?: string,
): Promise<CriticResult> {
  const { facts } = loadFacts();
  const p = product();
  const extra = (p.criticNotes ?? []).length
    ? ` Product-specific violations: ${(p.criticNotes ?? []).join(" ")}`
    : "";
  const system = `You are a strict brand & truth reviewer for ${p.name} marketing copy. Block anything that: states a fact not supported by the FACT BASE (or the RELEASE TAG / RELEASE NOTES, when supplied — both are engine-supplied ground truth for this copy); characterizes a competitor; over-promises; uses hype/clickbait; or breaks the warm/calm brand voice.${extra} When in doubt, BLOCK. Reply with ONLY compact JSON: {"verdict":"pass"|"block","reason":"<short>"}.

FACT BASE:
<factbase>
${facts}
</factbase>`;
  const user = `CONTEXT: ${context}${
    releaseTag
      ? `\n\nRELEASE TAG (engine-supplied, factual — the copy is EXPECTED to state this version): ${releaseTag}`
      : ""
  }${
    releaseNotes
      ? `\n\nRELEASE NOTES (verbatim, factual for this copy):\n<release-notes>\n${releaseNotes}\n</release-notes>`
      : ""
  }\n\nCOPY TO REVIEW:\n<<<\n${text}\n>>>`;

  try {
    const r = await runClaude(system, user, env.criticModel);
    const json = JSON.parse(r.text.replace(/^```(json)?|```$/g, "").trim());
    const verdict = json.verdict === "pass" ? "pass" : "block";
    return {
      verdict,
      reason: String(json.reason ?? "").slice(0, 300),
      model: env.criticModel,
    };
  } catch (err) {
    // Fail closed: a critic we can't run or parse must not let copy through.
    return {
      verdict: "block",
      reason: `critic error (fail-closed): ${(err as Error).message}`,
      model: env.criticModel,
    };
  }
}
