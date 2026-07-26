import { spawn } from "node:child_process";
import { env } from "@/lib/env";

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}
export interface ClaudeResult {
  text: string;
  usage: ClaudeUsage;
}

/**
 * Runs the Claude Code CLI headlessly: `claude -p --output-format json`.
 *
 * Why the CLI instead of @anthropic-ai/sdk: it reuses the operator's existing
 * Claude Code authentication (subscription / OAuth token / ANTHROPIC_API_KEY
 * if set) rather than a separately metered API key.
 *
 * RUNTIME REQUIREMENT: the `claude` binary must exist and be authenticated in
 * whatever process calls this. Vercel serverless functions do NOT provide it
 * — run the AI-bearing crons on a host that has Claude Code (local launchd, a
 * self-hosted runner, or GitHub Actions with CLAUDE_CODE_OAUTH_TOKEN). See
 * SETUP.md. The DB / GitHub-commit parts are unaffected.
 *
 * System + user are concatenated into a single stdin prompt (robust across
 * CLI versions — no reliance on a --system-prompt flag). One non-agentic turn,
 * no tools.
 */
export function runClaude(
  system: string,
  user: string,
  model: string,
): Promise<ClaudeResult> {
  const bin = env.claudeBin;
  const args = [
    "-p",
    "--output-format",
    "json",
    "--max-turns",
    "1",
    // Enforce the non-agentic contract: a tool call would burn the single
    // turn and surface as error_max_turns.
    "--disallowedTools",
    "*",
    "--strict-mcp-config",
    "--model",
    model,
    ...env.claudeCliExtraArgs,
  ];
  const prompt = `${system}\n\n=== TASK ===\n\n${user}`;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return reject(new Error(`failed to spawn '${bin}': ${(err as Error).message}`));
    }

    let out = "";
    let errOut = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${env.claudeTimeoutMs}ms`));
    }, env.claudeTimeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === "ENOENT"
          ? new Error(
              `'${bin}' not found on PATH. The claude-cli AI provider needs Claude Code installed + authenticated in this runtime (see SETUP.md).`,
            )
          : err,
      );
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new Error(`claude CLI exited ${code}: ${errOut.trim() || out.trim()}`),
        );
      }
      try {
        const j = JSON.parse(out);
        if (j.is_error || (j.subtype && j.subtype !== "success")) {
          return reject(new Error(`claude CLI result error: ${j.subtype} ${j.result ?? ""}`));
        }
        const u = j.usage ?? {};
        resolve({
          text: String(j.result ?? "").trim(),
          usage: {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
            costUsd: j.total_cost_usd ?? 0,
          },
        });
      } catch (e) {
        reject(new Error(`unparseable claude CLI output: ${(e as Error).message}: ${out.slice(0, 300)}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
