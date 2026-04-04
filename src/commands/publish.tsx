import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readInventory } from "../lib/inventory/store.ts";
import {
  readAuthToken,
  startDeviceFlow,
  pollForToken,
  publishToApi,
  PendingError,
  SlowDownError,
} from "../lib/auth.ts";
import type { Inventory, Project } from "../lib/types.ts";
import { exec } from "node:child_process";

type Phase = "checking" | "auth" | "polling" | "reading" | "checking-public" | "publishing" | "done" | "error";

interface Props {
  options: { bio?: string; noOpen?: boolean };
}

export default function Publish({ options }: Props) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");
  const [publicCount, setPublicCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    run();
  }, []);

  async function run() {
    try {
      // 1. Check for existing token
      setPhase("checking");
      let auth = await readAuthToken();

      // 2. Auth if needed
      if (!auth?.jwt) {
        setPhase("auth");
        const flow = await startDeviceFlow();
        setUserCode(flow.userCode);
        setVerificationUri(flow.verificationUri);

        try { exec(`open ${flow.verificationUri}`); } catch {}

        setPhase("polling");
        let interval = flow.interval;
        while (true) {
          await sleep(interval * 1000);
          try {
            auth = await pollForToken(flow.deviceCode);
            break;
          } catch (e) {
            if (e instanceof PendingError) continue;
            if (e instanceof SlowDownError) { interval += 2; continue; }
            throw e;
          }
        }
      }

      // 3. Read inventory
      setPhase("reading");
      const inventory = await readInventory();

      if (inventory.projects.length === 0) {
        setError("No projects found. Run `agent-cv scan ~/Projects` first.");
        setPhase("error");
        return;
      }

      // 4. Check which repos are public via GitHub API
      setPhase("checking-public");
      const projects = inventory.projects.filter((p) => p.included !== false);
      setTotalCount(projects.length);
      const publicFlags = await checkPublicRepos(projects);
      setPublicCount(Object.values(publicFlags).filter(Boolean).length);

      // 5. Sanitize and publish
      setPhase("publishing");
      const payload = sanitizeForPublish(inventory, publicFlags, options.bio);

      try {
        const result = await publishToApi(auth!.jwt, payload);
        setResultUrl(result.url);
        setPhase("done");

        // Auto-open browser
        if (!options.noOpen) {
          try { exec(`open ${result.url}`); } catch {}
        }
      } catch (e: any) {
        if (e.message === "AUTH_EXPIRED") {
          const { writeAuthToken } = await import("../lib/auth.ts");
          await writeAuthToken({ jwt: "", username: "", obtainedAt: "" });
          setError("Session expired. Run `agent-cv publish` again to re-authenticate.");
          setPhase("error");
        } else {
          throw e;
        }
      }
    } catch (e: any) {
      setError(e.message || "Unknown error");
      setPhase("error");
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      {phase === "checking" && <Text color="gray">Checking authentication...</Text>}

      {phase === "auth" && (
        <Box flexDirection="column" gap={1}>
          <Text>Open this URL in your browser:</Text>
          <Text bold color="cyan">{verificationUri}</Text>
          <Text>Enter code: <Text bold color="yellow">{userCode}</Text></Text>
        </Box>
      )}

      {phase === "polling" && (
        <Box flexDirection="column" gap={1}>
          <Text color="gray">Waiting for authorization...</Text>
          <Text>Enter code: <Text bold color="yellow">{userCode}</Text></Text>
          <Text color="gray">at {verificationUri}</Text>
        </Box>
      )}

      {phase === "reading" && <Text color="gray">Reading inventory...</Text>}

      {phase === "checking-public" && (
        <Text color="gray">Checking public/private repos... ({publicCount}/{totalCount})</Text>
      )}

      {phase === "publishing" && <Text color="gray">Publishing to agent-cv.dev...</Text>}

      {phase === "done" && (
        <Box flexDirection="column" gap={1}>
          <Text> </Text>
          <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} flexDirection="column" alignItems="center">
            <Text bold>Your portfolio is live at</Text>
            <Text bold color="cyan">{resultUrl}</Text>
          </Box>
          <Text color="gray">{publicCount} public repos, {totalCount - publicCount} private (URLs hidden)</Text>
          <Text> </Text>
        </Box>
      )}

      {phase === "error" && <Text color="red">Error: {error}</Text>}
    </Box>
  );
}

/**
 * Check which projects have public GitHub repos.
 * Uses unauthenticated GitHub API — public repos return 200, private return 404.
 */
async function checkPublicRepos(
  projects: Project[]
): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {};

  // Only check projects with GitHub remoteUrls
  const toCheck = projects.filter(
    (p) => p.remoteUrl?.includes("github.com")
  );

  // Batch in parallel, 10 at a time
  for (let i = 0; i < toCheck.length; i += 10) {
    const batch = toCheck.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (p) => {
        try {
          // Extract owner/repo from URL
          const match = p.remoteUrl!.match(/github\.com\/([^/]+\/[^/]+)/);
          if (!match) return { id: p.id, isPublic: false };

          const res = await fetch(`https://api.github.com/repos/${match[1]}`, {
            method: "HEAD",
          });
          return { id: p.id, isPublic: res.status === 200 };
        } catch {
          return { id: p.id, isPublic: false };
        }
      })
    );
    for (const r of results) flags[r.id] = r.isPublic;
  }

  // Non-GitHub repos default to false
  for (const p of projects) {
    if (!(p.id in flags)) flags[p.id] = false;
  }

  return flags;
}

function sanitizeForPublish(
  inventory: Inventory,
  publicFlags: Record<string, boolean>,
  bio?: string
) {
  const projects = inventory.projects
    .filter((p) => p.included !== false)
    .map((p: Project) => {
      const isPublic = publicFlags[p.id] ?? false;
      return {
        id: p.id,
        displayName: p.displayName,
        type: p.type,
        language: p.language,
        frameworks: p.frameworks,
        dateRange: p.dateRange,
        hasGit: p.hasGit,
        commitCount: p.commitCount,
        authorCommitCount: p.authorCommitCount,
        hasUncommittedChanges: p.hasUncommittedChanges,
        lastCommit: p.lastCommit,
        analysis: p.analysis,
        tags: p.tags,
        included: true,
        remoteUrl: isPublic ? p.remoteUrl : null,
        isPublic,
      };
    });

  return { inventory: { version: inventory.version, projects }, bio };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
