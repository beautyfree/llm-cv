import simpleGit from "simple-git";

export interface GitMetadata {
  firstCommitDate: string;
  lastCommitDate: string;
  totalCommits: number;
  authorCommits: number;
  authorEmail: string;
}

/**
 * Collect all known email addresses for the current user.
 * Checks: global git config, env vars, and optionally user-provided list.
 *
 * Call once at scan start, pass the result to extractGitMetadata for each repo.
 */
export async function collectUserEmails(
  extraEmails: string[] = []
): Promise<Set<string>> {
  const emails = new Set<string>();

  // 1. Global git config
  try {
    const git = simpleGit();
    const globalEmail = (
      await git.raw(["config", "--global", "user.email"])
    ).trim();
    if (globalEmail) emails.add(globalEmail.toLowerCase());
  } catch {
    // no global config
  }

  // 2. Environment variables (some CI/CD systems set these)
  const envEmail =
    process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL;
  if (envEmail) emails.add(envEmail.toLowerCase());

  // 3. User-provided extras (from config file or --email flag)
  for (const e of extraEmails) {
    if (e.includes("@")) emails.add(e.toLowerCase());
  }

  return emails;
}

/**
 * Discover additional emails by scanning a repo's commit log.
 * Finds the repo-local user.email and checks if the most frequent
 * committer matches any known email. This catches the case where
 * a repo has a different local config than the global one.
 */
export async function discoverRepoEmails(
  dir: string,
  knownEmails: Set<string>
): Promise<string[]> {
  const discovered: string[] = [];

  try {
    const git = simpleGit(dir);

    // Check repo-local email config
    try {
      const localEmail = (
        await git.raw(["config", "--local", "user.email"])
      ).trim();
      if (localEmail && !knownEmails.has(localEmail.toLowerCase())) {
        discovered.push(localEmail.toLowerCase());
      }
    } catch {
      // no local config
    }
  } catch {
    // not a git repo or git not installed
  }

  return discovered;
}

/**
 * Extract git metadata from a repository.
 * Uses a set of known user emails to count "my" commits across
 * all of the user's identities (work email, personal email, old email, etc.)
 */
export async function extractGitMetadata(
  dir: string,
  userEmails: Set<string>
): Promise<GitMetadata | null> {
  try {
    const git = simpleGit(dir);

    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;

    // Get total commit count
    let totalCommits = 0;
    try {
      const countOutput = await git.raw(["rev-list", "--count", "HEAD"]);
      totalCommits = parseInt(countOutput.trim(), 10) || 0;
    } catch {
      return null;
    }

    // Get first and last commit dates
    let firstCommitDate = "";
    let lastCommitDate = "";
    try {
      const firstLog = await git.raw([
        "log",
        "--reverse",
        "--format=%aI",
        "--max-count=1",
      ]);
      firstCommitDate = firstLog.trim().split("T")[0] || "";

      const lastLog = await git.raw(["log", "--format=%aI", "--max-count=1"]);
      lastCommitDate = lastLog.trim().split("T")[0] || "";
    } catch {
      // Can't get dates
    }

    // Count commits across ALL known user emails
    let authorCommits = 0;
    let matchedEmail = "";

    for (const email of userEmails) {
      try {
        const count = await git.raw([
          "rev-list",
          "--count",
          "--author",
          email,
          "HEAD",
        ]);
        const n = parseInt(count.trim(), 10) || 0;
        authorCommits += n;
        if (n > 0 && !matchedEmail) matchedEmail = email;
      } catch {
        // ignore
      }
    }

    // Fallback: if no known emails matched, check repo-local config
    if (authorCommits === 0) {
      try {
        const localEmail = (
          await git.raw(["config", "user.email"])
        ).trim();
        if (localEmail) {
          const count = await git.raw([
            "rev-list",
            "--count",
            "--author",
            localEmail,
            "HEAD",
          ]);
          const n = parseInt(count.trim(), 10) || 0;
          authorCommits = n;
          matchedEmail = localEmail;
        }
      } catch {
        // ignore
      }
    }

    return {
      firstCommitDate,
      lastCommitDate,
      totalCommits,
      authorCommits,
      authorEmail: matchedEmail,
    };
  } catch {
    return null;
  }
}
