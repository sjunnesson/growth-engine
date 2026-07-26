import { env } from "@/lib/env";
import { loadFacts } from "@/lib/sources/factbase";
import { runClaude } from "@/lib/claude/cli";
import { systemText } from "@/lib/claude/cache";
import { buildUserMessage, type GenJob } from "@/lib/claude/prompts";

export interface GenResult {
  text: string;
  meta: {
    provider: "claude-cli";
    model: string;
    factbaseVersion: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  };
}

/** One generation call via the Claude Code CLI (`claude -p`). */
export async function generate(job: GenJob): Promise<GenResult> {
  const { version } = loadFacts();
  const r = await runClaude(systemText(), buildUserMessage(job), env.genModel);
  return {
    text: r.text,
    meta: {
      provider: "claude-cli",
      model: env.genModel,
      factbaseVersion: version,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cacheCreationTokens: r.usage.cacheCreationTokens,
      cacheReadTokens: r.usage.cacheReadTokens,
      costUsd: r.usage.costUsd,
    },
  };
}
