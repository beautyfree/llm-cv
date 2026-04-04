import React, { useState, useCallback } from "react";
import { Text, Box } from "ink";
import { MarkdownRenderer } from "../lib/output/markdown-renderer.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { generateBioFromProjects } from "../lib/pipeline.ts";
import { Pipeline, type PipelineResult } from "../components/Pipeline.tsx";

interface Props {
  args: [string];
  options: {
    output?: string;
    agent?: string;
    noCache?: boolean;
    dryRun?: boolean;
    all?: boolean;
    email?: string;
  };
}

export default function Generate({ args: [directory], options }: Props) {
  const { output, dryRun } = options;
  const [phase, setPhase] = useState<"pipeline" | "rendering" | "done" | "error">("pipeline");
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<PipelineResult | null>(null);

  const handleComplete = useCallback(async ({ projects, inventory, adapter }: PipelineResult) => {
    try {
      setPhase("rendering");

      // Generate bio if needed
      const config = await readConfig();
      if (!dryRun && !config.bio && adapter) {
        try {
          const bio = await generateBioFromProjects(projects, adapter);
          if (bio) { config.bio = bio; await writeConfig(config); }
        } catch { /* optional */ }
      }

      const renderer = new MarkdownRenderer();
      const md = renderer.render(inventory, projects.map((p) => p.id), config);
      setMarkdown(md);
      if (output && !dryRun) await Bun.write(output, md);
      setResult({ projects, inventory, adapter });
      setPhase("done");
    } catch (err: any) { setError(err.message); setPhase("error"); }
  }, [output, dryRun]);

  if (phase === "error") return <Text color="red">Error: {error}</Text>;

  if (phase === "pipeline") return (
    <Pipeline
      options={{ directory, ...options }}
      onComplete={handleComplete}
      onError={(msg) => { setError(msg); setPhase("error"); }}
    />
  );

  if (phase === "rendering") return <Text color="yellow">Generating CV...</Text>;

  // Done
  const analyzed = result?.projects.filter((p) => p.analysis).length ?? 0;
  const total = result?.projects.length ?? 0;

  return (
    <Box flexDirection="column">
      <Text color="green" bold>CV generated! {total} projects, {analyzed} analyzed.</Text>
      {output ? <Text dimColor>Written to: {output}</Text> : <><Text> </Text><Text>{markdown}</Text></>}
    </Box>
  );
}
