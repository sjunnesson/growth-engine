import { octokit, splitRepo } from "@/lib/github/octokit";
import { product } from "@/lib/product";

export interface CommitResult {
  sha: string;
  htmlUrl: string;
  path: string;
}

/**
 * Create-or-update a single file in the website repo on the configured branch.
 * The commit IS the audit trail + rollback path (`git revert`). The site
 * auto-deploys on push, so this is how content reaches a static site without
 * giving that site a runtime.
 *
 * Idempotent at the content level: if the file already has identical content
 * we skip the commit (no empty-diff churn, safe to retry).
 */
export async function commitFile(
  path: string,
  content: string,
  message: string,
): Promise<CommitResult & { skipped?: boolean }> {
  const { owner, repo } = splitRepo(product().github.websiteRepo);
  const branch = product().github.websiteBranch;
  const kit = octokit();

  let existingSha: string | undefined;
  try {
    const { data } = await kit.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(data) && data.type === "file") {
      existingSha = data.sha;
      const current = Buffer.from(data.content, "base64").toString("utf-8");
      if (current === content) {
        return {
          sha: data.sha,
          htmlUrl: data.html_url ?? "",
          path,
          skipped: true,
        };
      }
    }
  } catch {
    // 404 => new file, leave existingSha undefined.
  }

  // No author/committer override: GitHub attributes the commit to the PAT
  // owner. A synthetic bot identity is not a Vercel team member, and Vercel's
  // Hobby plan refuses to deploy commits from non-member authors — the
  // "[<slug>-growth]" tag in the message keeps the bot trail.
  const { data } = await kit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha: existingSha,
  });
  return {
    sha: data.commit.sha ?? "",
    htmlUrl: data.content?.html_url ?? "",
    path,
  };
}
