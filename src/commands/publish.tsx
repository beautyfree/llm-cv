import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { readInventory, writeInventory } from "../lib/inventory/store.ts";
import { scanDirectory } from "../lib/discovery/scanner.ts";
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

type Phase = "checking" | "auth" | "polling" | "scanning" | "reading" | "checking-public" | "publishing" | "done" | "error";

interface Props {
  args?: string[];
  options: { bio?: string; noOpen?: boolean };
}

export default function Publish({ args, options }: Props) {
  const dir = args?.[0];
  const [phase, setPhase] = useState<Phase>("checking");
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");
  const [publicCount, setPublicCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [scanCount, setScanCount] = useState(0);
  const [analyzedCount, setAnalyzedCount] = useState(0);

  useEffect(() => {
    run();
  }, []);

  async function run() {
    try {
      // 1. Auth
      setPhase("checking");
      let auth = await readAuthToken();

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

      // 2. Smart scan: if dir provided, run scan first
      let inventory = await readInventory();

      if (dir) {
        setPhase("scanning");
        const { collectUserEmails } = await import("../lib/discovery/git-metadata.ts");
        const userEmails = await collectUserEmails();
        const scanned = await scanDirectory(dir, userEmails);
        setScanCount(scanned.length);

        // Merge with existing inventory
        const { mergeInventory } = await import("../lib/inventory/store.ts");
        inventory = mergeInventory(inventory, scanned, dir);
        await writeInventory(inventory);
      }

      setPhase("reading");
      if (inventory.projects.length === 0) {
        setError("No projects found. Provide a directory: `agent-cv publish ~/Projects`");
        setPhase("error");
        return;
      }

      const included = inventory.projects.filter((p) => p.included !== false);
      const withAnalysis = included.filter((p) => p.analysis);
      setAnalyzedCount(withAnalysis.length);
      setTotalCount(included.length);

      // 3. Check public/private
      setPhase("checking-public");
      const publicFlags = await checkPublicRepos(included);
      setPublicCount(Object.values(publicFlags).filter(Boolean).length);

      // 4. Publish
      setPhase("publishing");
      const payload = sanitizeForPublish(inventory, publicFlags, options.bio);

      try {
        const result = await publishToApi(auth!.jwt, payload);
        setResultUrl(result.url);
        setPhase("done");
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
        </Box>
      )}

      {phase === "scanning" && <Text color="gray">Scanning {dir}...</Text>}
      {phase === "reading" && <Text color="gray">Reading inventory ({totalCount} projects)...</Text>}
      {phase === "checking-public" && <Text color="gray">Checking repos... ({publicCount}/{totalCount})</Text>}
      {phase === "publishing" && <Text color="gray">Publishing to agent-cv.dev...</Text>}

      {phase === "done" && (
        <Box flexDirection="column" gap={1}>
          <Text> </Text>
          <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} flexDirection="column" alignItems="center">
            <Text bold>Your portfolio is live at</Text>
            <Text bold color="cyan">{resultUrl}</Text>
          </Box>
          <Text color="gray">
            {totalCount} projects ({analyzedCount} with AI analysis) · {publicCount} public, {totalCount - publicCount} private
          </Text>
          {analyzedCount < totalCount && (
            <Text color="yellow">
              {totalCount - analyzedCount} projects without AI analysis. Run `agent-cv generate {dir || "~/Projects"}` to analyze them.
            </Text>
          )}
          <Text> </Text>
        </Box>
      )}

      {phase === "error" && <Text color="red">Error: {error}</Text>}
    </Box>
  );
}

async function checkPublicRepos(projects: Project[]): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {};
  const toCheck = projects.filter((p) => p.remoteUrl?.includes("github.com"));

  for (let i = 0; i < toCheck.length; i += 10) {
    const batch = toCheck.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (p) => {
        try {
          const match = p.remoteUrl!.match(/github\.com\/([^/]+\/[^/]+)/);
          if (!match) return { id: p.id, isPublic: false };
          const res = await fetch(`https://api.github.com/repos/${match[1]}`, {
            redirect: "follow",
            headers: { "User-Agent": "agent-cv" },
          });
          if (res.status === 200) {
            const data = await res.json();
            return { id: p.id, isPublic: !data.private };
          }
          return { id: p.id, isPublic: false };
        } catch {
          return { id: p.id, isPublic: false };
        }
      })
    );
    for (const r of results) flags[r.id] = r.isPublic;
  }

  for (const p of projects) {
    if (!(p.id in flags)) flags[p.id] = false;
  }
  return flags;
}

function sanitizeForPublish(inventory: Inventory, publicFlags: Record<string, boolean>, bio?: string) {
  const projects = inventory.projects
    .filter((p) => p.included !== false)
    .map((p: Project) => {
      const isPublic = publicFlags[p.id] ?? false;
      return {
        id: p.id, displayName: p.displayName, type: p.type, language: p.language,
        frameworks: p.frameworks, dateRange: p.dateRange, hasGit: p.hasGit,
        commitCount: p.commitCount, authorCommitCount: p.authorCommitCount,
        hasUncommittedChanges: p.hasUncommittedChanges, lastCommit: p.lastCommit,
        analysis: p.analysis, tags: p.tags, included: true,
        remoteUrl: isPublic ? p.remoteUrl : null, isPublic,
      };
    });

  return { inventory: { version: inventory.version, projects }, bio };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
