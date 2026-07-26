// Centralized, typed env access. Throws early for required vars so a
// misconfigured deploy fails loudly instead of silently mis-behaving.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  // Safety posture
  growthHalt: process.env.GROWTH_HALT === "1",
  dryRun: process.env.DRY_RUN !== "false", // default true unless explicitly "false"
  liveChannels: new Set(
    opt("LIVE_CHANNELS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),

  // Auth
  cronSecret: () => req("CRON_SECRET"),
  adminToken: () => req("ADMIN_TOKEN"),

  // Data
  databaseUrl: () => req("DATABASE_URL"),

  // Claude — via the Claude Code CLI (`claude -p`), reusing existing auth.
  // No ANTHROPIC_API_KEY required here (the CLI handles auth itself; it will
  // use one only if the operator has it set in its own environment).
  claudeBin: opt("CLAUDE_BIN", "claude"),
  genModel: opt("CLAUDE_GEN_MODEL", "sonnet"),
  criticModel: opt("CLAUDE_CRITIC_MODEL", "haiku"),
  claudeTimeoutMs: Number(opt("CLAUDE_TIMEOUT_MS", "240000")),
  claudeCliExtraArgs: opt("CLAUDE_CLI_EXTRA_ARGS")
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean),

  // GitHub. Repo/site targets live in product.json (lib/product.ts) — the
  // GITHUB_RELEASES_REPO / GITHUB_WEBSITE_REPO / GITHUB_WEBSITE_BRANCH /
  // SITE_URL env vars still override them there.
  githubToken: () => req("GITHUB_TOKEN"),

  // Social
  mastodon: {
    baseUrl: opt("MASTODON_BASE_URL"),
    token: opt("MASTODON_ACCESS_TOKEN"),
  },
  bluesky: {
    identifier: opt("BLUESKY_IDENTIFIER"),
    appPassword: opt("BLUESKY_APP_PASSWORD"),
  },
  linkedin: {
    token: opt("LINKEDIN_ACCESS_TOKEN"),
    authorUrn: opt("LINKEDIN_AUTHOR_URN"),
  },
  reddit: {
    clientId: opt("REDDIT_CLIENT_ID"),
    clientSecret: opt("REDDIT_CLIENT_SECRET"),
    refreshToken: opt("REDDIT_REFRESH_TOKEN"),
    userAgent: opt("REDDIT_USER_AGENT", "growth-engine/0.1"),
    subreddits: opt("REDDIT_SUBREDDITS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  x: { bearer: opt("X_BEARER_TOKEN") },
};

/** Is this channel cleared to actually publish (not dry-run)? */
export function isChannelLive(channel: string): boolean {
  if (env.dryRun) return env.liveChannels.has(channel);
  // DRY_RUN=false is global go-live; LIVE_CHANNELS still scopes it if set.
  return env.liveChannels.size === 0 || env.liveChannels.has(channel);
}
