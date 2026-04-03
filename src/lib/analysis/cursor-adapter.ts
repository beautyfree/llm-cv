import type { AgentAdapter, ProjectAnalysis, ProjectContext } from "../types.ts";

/**
 * Cursor Agent CLI adapter.
 * Uses `agent` (cursor-agent) in headless mode with --trust -p.
 * Docs: https://cursor.com/docs/cli/headless
 */
export class CursorAdapter implements AgentAdapter {
  name = "cursor";

  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", "agent"], { stdout: "pipe", stderr: "pipe" });
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  }

  async analyze(context: ProjectContext): Promise<ProjectAnalysis> {
    const prompt = buildPrompt(context);

    // Use --trust to skip workspace trust prompt, -p for headless print mode
    const proc = Bun.spawn(
      ["agent", "--trust", "-p", prompt],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: context.path,
        timeout: 120_000,
      }
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Cursor agent exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }
    if (!stdout.trim()) throw new Error("Cursor agent returned empty response");

    return parseResponse(stdout);
  }
}

function buildPrompt(context: ProjectContext): string {
  const parts: string[] = [];

  if (context.previousAnalysis) {
    parts.push(
      "Previous analysis:", JSON.stringify(context.previousAnalysis, null, 2), "",
      "Project changed since. Update the analysis: keep what's accurate, add new contributions.",
      "Respond with ONLY a JSON object:",
    );
  } else {
    parts.push("Analyze this software project and respond with ONLY a JSON object (no markdown, no explanation).", "");
  }

  parts.push('{"summary": "2-3 sentence description", "techStack": ["Tech1", "Tech2"], "contributions": ["Key feature 1", "Key feature 2"]}', "");
  if (context.readme) parts.push("=== README ===", context.readme, "");
  if (context.dependencies) parts.push("=== DEPENDENCIES ===", context.dependencies, "");
  if (context.directoryTree) parts.push("=== DIRECTORY STRUCTURE ===", context.directoryTree, "");
  if (context.gitShortlog) parts.push("=== GIT CONTRIBUTORS ===", context.gitShortlog, "");
  if (context.recentCommits) parts.push("=== RECENT COMMITS ===", context.recentCommits, "");

  return parts.join("\n");
}

function parseResponse(raw: string): ProjectAnalysis {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in Cursor response");

  const parsed = JSON.parse(jsonMatch[0]);
  const analysis: ProjectAnalysis = {
    summary: parsed.summary || "",
    techStack: Array.isArray(parsed.techStack) ? parsed.techStack : [],
    contributions: Array.isArray(parsed.contributions) ? parsed.contributions : [],
    analyzedAt: new Date().toISOString(),
    analyzedBy: "cursor",
  };

  if (!analysis.summary) throw new Error("Analysis has empty summary");
  if (analysis.techStack.length === 0) throw new Error("Analysis has empty techStack");

  return analysis;
}
