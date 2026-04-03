import React, { useEffect, useState, useCallback } from "react";
import { Text, Box } from "ink";
import { z } from "zod/v4";
import { scanDirectory } from "../lib/discovery/scanner.ts";
import {
  readInventory,
  writeInventory,
  mergeInventory,
} from "../lib/inventory/store.ts";
import { buildProjectContext } from "../lib/analysis/context-builder.ts";
import { ClaudeAdapter } from "../lib/analysis/claude-adapter.ts";
import { MarkdownRenderer } from "../lib/output/markdown-renderer.ts";
import { ProjectSelector } from "../components/ProjectSelector.tsx";
import { EmailPicker } from "../components/EmailPicker.tsx";
import { readConfig, writeConfig } from "../lib/config.ts";
import {
  collectUserEmails,
  collectAllRepoEmails,
} from "../lib/discovery/git-metadata.ts";
import type { Project, Inventory } from "../lib/types.ts";

export const args = z.tuple([
  z.string().describe("Directory to scan for projects"),
]);

export const options = z.object({
  output: z.string().optional().describe("Output file path (default: stdout)"),
  agent: z.string().default("claude").describe("Agent to use for analysis"),
  noCache: z.boolean().default(false).describe("Force fresh analysis, ignore cache"),
  dryRun: z.boolean().default(false).describe("Show what would be sent to the LLM without sending"),
  all: z.boolean().default(false).describe("Skip interactive selection, analyze all projects"),
  email: z.string().optional().describe("Email(s) to filter by, for generating someone else's CV (comma-separated)"),
});

type Props = {
  args: z.infer<typeof args>;
  options: z.infer<typeof options>;
};

type Phase =
  | "scanning"
  | "picking-emails"
  | "rescanning"
  | "selecting"
  | "checking-agent"
  | "analyzing"
  | "rendering"
  | "done"
  | "error";

export default function Generate({
  args: [directory],
  options: { output, agent, noCache, dryRun, all: selectAll, email },
}: Props) {
  const [phase, setPhase] = useState<Phase>("scanning");
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Project[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [current, setCurrent] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");

  // Email picker state
  const [emailCounts, setEmailCounts] = useState<Map<string, number>>(new Map());
  const [gitConfigEmails, setGitConfigEmails] = useState<Set<string>>(new Set());
  const [confirmedEmails, setConfirmedEmails] = useState<string[]>([]);

  // Phase 1: Initial scan + email resolution
  useEffect(() => {
    async function initialScan() {
      try {
        // If --email is provided, use those directly (generating for someone else)
        if (email) {
          const emails = email.split(",").map((e) => e.trim());
          setConfirmedEmails(emails);
          setPhase("rescanning");
          return;
        }

        // Check saved config
        const config = await readConfig();
        if (config.emailsConfirmed && config.emails.length > 0) {
          setConfirmedEmails(config.emails);
          setPhase("rescanning");
          return;
        }

        // No saved emails. Do a quick scan to discover all emails from repos.
        const scanResult = await scanDirectory(directory, { verbose: false, emails: [] });

        if (scanResult.projects.length === 0) {
          setError(`No projects found in ${directory}`);
          setPhase("error");
          return;
        }

        // Collect all emails from git shortlog across all scanned repos
        const gitDirs = scanResult.projects
          .filter((p) => p.hasGit)
          .map((p) => p.path);
        const allEmails = await collectAllRepoEmails(gitDirs);
        const configEmails = await collectUserEmails([]);

        if (allEmails.size <= 1) {
          // Only one email (or zero) found, no ambiguity
          const emails = allEmails.size === 1
            ? [...allEmails.keys()]
            : [...configEmails];
          setConfirmedEmails(emails);

          // Save it so we don't ask again
          if (emails.length > 0) {
            await writeConfig({ emails, emailsConfirmed: true });
          }

          setPhase("rescanning");
          return;
        }

        // Multiple emails found. Show picker.
        setEmailCounts(allEmails);
        setGitConfigEmails(configEmails);
        setPhase("picking-emails");
      } catch (err: any) {
        setError(err.message);
        setPhase("error");
      }
    }
    initialScan();
  }, [directory, email]);

  // Handle email picker submit
  const handleEmailPick = useCallback(async (selected: string[], save: boolean) => {
    setConfirmedEmails(selected);
    if (save) {
      await writeConfig({ emails: selected, emailsConfirmed: true });
    }
    setPhase("rescanning");
  }, []);

  // Phase 2: Rescan with confirmed emails
  useEffect(() => {
    if (phase !== "rescanning") return;

    async function rescan() {
      try {
        const scanResult = await scanDirectory(directory, {
          verbose: false,
          emails: confirmedEmails,
        });

        if (scanResult.projects.length === 0) {
          setError(`No projects found in ${directory}`);
          setPhase("error");
          return;
        }

        const existingInventory = await readInventory();
        const merged = mergeInventory(
          existingInventory,
          scanResult.projects,
          directory
        );
        await writeInventory(merged);
        setInventory(merged);

        const available = merged.projects.filter(
          (p) => !p.tags.includes("removed")
        );
        setAllProjects(available);

        if (selectAll) {
          setSelectedProjects(available);
          setPhase("checking-agent");
        } else {
          setPhase("selecting");
        }
      } catch (err: any) {
        setError(err.message);
        setPhase("error");
      }
    }
    rescan();
  }, [phase, confirmedEmails, directory, selectAll]);

  // Handle project selection submit
  const handleSelection = useCallback((selected: Project[]) => {
    if (selected.length === 0) {
      setError("No projects selected.");
      setPhase("error");
      return;
    }
    setSelectedProjects(selected);
    setPhase("checking-agent");
  }, []);

  // Phase 3+4+5: Agent check, analyze, render
  useEffect(() => {
    if (phase !== "checking-agent") return;

    async function analyzeAndRender() {
      try {
        const adapter = new ClaudeAdapter();
        const available = await adapter.isAvailable();

        if (!available) {
          setError(
            `Agent "${agent}" not found in PATH.\n\n` +
              "Install Claude Code: https://claude.ai/claude-code\n" +
              "Or set an API key: export OPENROUTER_API_KEY=..."
          );
          setPhase("error");
          return;
        }

        setPhase("analyzing");
        const toAnalyze = noCache
          ? selectedProjects
          : selectedProjects.filter((p) => !p.analysis);

        setProgress({ done: 0, total: toAnalyze.length });

        for (let i = 0; i < toAnalyze.length; i++) {
          const project = toAnalyze[i]!;
          setCurrent(project.displayName);

          if (dryRun) {
            const context = await buildProjectContext(project);
            const totalChars =
              context.readme.length +
              context.dependencies.length +
              context.directoryTree.length +
              context.gitShortlog.length +
              context.recentCommits.length;
            console.error(
              `\n--- DRY RUN: ${project.displayName} ---\n` +
                `Context size: ~${Math.round(totalChars / 4)} tokens\n`
            );
            setProgress({ done: i + 1, total: toAnalyze.length });
            continue;
          }

          try {
            const context = await buildProjectContext(project);
            const analysis = await adapter.analyze(context);
            project.analysis = analysis;
          } catch (err: any) {
            console.error(
              `Warning: Failed to analyze ${project.displayName}: ${err.message}`
            );
          }

          setProgress({ done: i + 1, total: toAnalyze.length });
        }

        if (!dryRun && inventory) {
          await writeInventory(inventory);
        }

        setPhase("rendering");
        const renderer = new MarkdownRenderer();
        const md = renderer.render(
          inventory!,
          selectedProjects.map((p) => p.id)
        );
        setMarkdown(md);

        if (output && !dryRun) {
          await Bun.write(output, md);
        }

        setPhase("done");
      } catch (err: any) {
        setError(err.message);
        setPhase("error");
      }
    }
    analyzeAndRender();
  }, [phase, selectedProjects, agent, noCache, dryRun, output, inventory]);

  // Render
  if (phase === "error") {
    return <Text color="red">Error: {error}</Text>;
  }

  if (phase === "scanning") {
    return <Text color="yellow">Scanning {directory} for projects...</Text>;
  }

  if (phase === "picking-emails") {
    return (
      <EmailPicker
        emailCounts={emailCounts}
        preSelected={gitConfigEmails}
        onSubmit={handleEmailPick}
      />
    );
  }

  if (phase === "rescanning") {
    return <Text color="yellow">Identifying your projects...</Text>;
  }

  if (phase === "selecting") {
    return (
      <ProjectSelector
        projects={allProjects}
        scanRoot={directory}
        onSubmit={handleSelection}
      />
    );
  }

  if (phase === "checking-agent") {
    return <Text color="yellow">Checking agent availability...</Text>;
  }

  if (phase === "analyzing") {
    return (
      <Box flexDirection="column">
        <Text color="yellow">
          Analyzing [{progress.done}/{progress.total}]: {current}
        </Text>
        {dryRun && <Text dimColor>(dry-run mode, no LLM calls)</Text>}
      </Box>
    );
  }

  if (phase === "rendering") {
    return <Text color="yellow">Generating CV...</Text>;
  }

  const analyzed = selectedProjects.filter((p) => p.analysis).length;
  const secrets = selectedProjects.reduce(
    (n, p) => n + (p.privacyAudit?.secretsFound ?? 0),
    0
  );

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        CV generated! {selectedProjects.length} projects, {analyzed} analyzed.
      </Text>
      {secrets > 0 && (
        <Text color="yellow">
          Privacy: {secrets} file{secrets !== 1 ? "s" : ""} with secrets
          excluded from analysis.
        </Text>
      )}
      {output ? (
        <Text dimColor>Written to: {output}</Text>
      ) : (
        <>
          <Text> </Text>
          <Text>{markdown}</Text>
        </>
      )}
    </Box>
  );
}

export const description =
  "Full flow: scan directory, analyze projects with AI, generate markdown CV";
