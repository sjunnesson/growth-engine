import { Octokit } from "@octokit/rest";
import { env } from "@/lib/env";

let _kit: Octokit | null = null;
export function octokit(): Octokit {
  if (!_kit)
    _kit = new Octokit({
      auth: env.githubToken(),
      userAgent: "growth-engine",
    });
  return _kit;
}

export function splitRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/");
  return { owner, repo };
}
