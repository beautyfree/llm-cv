import type { AgentAdapter, Project, ProjectContext } from "../types.ts";

export interface YearlyTheme {
  year: string;
  focus: string;
  topProjects: string[];
}

export interface ProfileInsights {
  bio: string;
  highlights: string[];
  narrative: string;
  strongestSkills: string[];
  uniqueTraits: string[];
  yearlyThemes: YearlyTheme[];
}

/**
 * Generate profile insights in two steps:
 * 1. Yearly themes — what was the developer focused on each year
 * 2. Final profile — bio, highlights, narrative, skills using yearly context
 */
export async function generateProfileInsights(
  projects: Project[],
  adapter: AgentAdapter,
  onStep?: (step: string) => void
): Promise<ProfileInsights | null> {
  const analyzed = projects.filter((p) => p.analysis);
  if (analyzed.length === 0) return null;

  // Step 1: Generate yearly themes
  onStep?.("analyzing yearly themes...");
  const yearlyThemes = await generateYearlyThemes(projects, adapter);

  // Step 2: Generate final profile using yearly context
  onStep?.("generating profile insights...");
  const profile = await generateFinalProfile(projects, adapter, yearlyThemes);

  if (!profile) return null;
  return { ...profile, yearlyThemes };
}

/**
 * Step 1: Group projects by year, ask LLM to identify themes per year.
 */
async function generateYearlyThemes(
  projects: Project[],
  adapter: AgentAdapter
): Promise<YearlyTheme[]> {
  // Group by year, only include primary/secondary tier projects
  const byYear = new Map<string, Project[]>();
  for (const p of projects) {
    if (p.tier === "minor" && !p.analysis) continue;
    const year = p.dateRange.end?.split("-")[0] || p.dateRange.start?.split("-")[0] || "Unknown";
    if (year === "Unknown") continue;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(p);
  }

  const sortedYears = [...byYear.keys()].sort();
  if (sortedYears.length === 0) return [];

  const yearSummaries = sortedYears.map((year) => {
    const yProjects = byYear.get(year)!;
    const lines = yProjects
      .sort((a, b) => (b.significance || 0) - (a.significance || 0))
      .slice(0, 10)
      .map((p) => {
        const tech = p.analysis?.techStack?.join(", ") || p.language;
        const desc = p.analysis?.summary?.slice(0, 80) || "";
        const tier = p.tier || "minor";
        const stars = p.stars ? ` ⭐${p.stars}` : "";
        return `  - [${tier}] ${p.displayName}${stars}: ${tech}. ${desc}`;
      })
      .join("\n");
    return `${year} (${yProjects.length} projects):\n${lines}`;
  }).join("\n\n");

  const prompt = [
    "Analyze this developer's projects grouped by year. Respond with ONLY a JSON array.",
    "",
    "Each element: {\"year\": \"2024\", \"focus\": \"one sentence about what they focused on\", \"topProjects\": [\"name1\", \"name2\"]}",
    "",
    "Guidelines:",
    "- focus: What domain/tech/pattern dominated that year? Be specific.",
    "- topProjects: 1-3 most significant projects of that year.",
    "- Skip years with only clones or trivial projects.",
    "",
    yearSummaries,
  ].join("\n");

  try {
    const result = await adapter.analyze({
      path: "", readme: "", dependencies: "", directoryTree: "", gitShortlog: "",
      recentCommits: "", rawPrompt: prompt,
    });
    const text = result.summary || "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return Array.isArray(parsed) ? parsed.filter((t: any) => t.year && t.focus) : [];
    }
  } catch { /* optional */ }
  return [];
}

/**
 * Step 2: Generate final profile using yearly themes as context.
 */
async function generateFinalProfile(
  projects: Project[],
  adapter: AgentAdapter,
  yearlyThemes: YearlyTheme[]
): Promise<Omit<ProfileInsights, "yearlyThemes"> | null> {
  // Sort by significance, include top projects with full details
  const sorted = [...projects].sort((a, b) => (b.significance || 0) - (a.significance || 0));
  const projectSummaries = sorted
    .slice(0, 50)
    .map((p) => {
      const tech = p.analysis?.techStack?.join(", ") || p.language;
      const desc = p.analysis?.summary?.slice(0, 120) || "";
      const commits = p.authorCommitCount || p.commitCount;
      const lines = p.size?.lines ? `${Math.round(p.size.lines / 1000)}K lines` : "";
      const stars = p.stars ? `, ⭐${p.stars}` : "";
      const tier = p.tier ? ` [${p.tier}]` : "";
      return `- ${p.displayName}${tier} (${p.dateRange.start?.split("-")[0] || "?"}, ${commits} commits${stars}${lines ? ", " + lines : ""}): ${tech}. ${desc}`;
    })
    .join("\n");

  const langCounts = new Map<string, number>();
  for (const p of projects) {
    if (p.language !== "Unknown") langCounts.set(p.language, (langCounts.get(p.language) || 0) + 1);
  }
  const topLangs = [...langCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l).join(", ");

  const fwCounts = new Map<string, number>();
  for (const p of projects) {
    for (const fw of p.frameworks) fwCounts.set(fw, (fwCounts.get(fw) || 0) + 1);
  }
  const topFw = [...fwCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([f]) => f).join(", ");

  const years = projects.map((p) => p.dateRange.start?.split("-")[0]).filter(Boolean).sort();
  const firstYear = years[0] || "?";

  const themesContext = yearlyThemes.length > 0
    ? "\nYearly evolution:\n" + yearlyThemes.map((t) => `- ${t.year}: ${t.focus} (${t.topProjects.join(", ")})`).join("\n") + "\n"
    : "";

  const primaryCount = projects.filter((p) => p.tier === "primary").length;
  const secondaryCount = projects.filter((p) => p.tier === "secondary").length;

  const prompt = [
    "Analyze this developer's portfolio and respond with ONLY a JSON object.",
    "",
    "The JSON must have this exact structure:",
    '{',
    '  "bio": "3-4 sentence professional bio. Third person. Specific, not generic.",',
    '  "highlights": ["project_name_1", "project_name_2", "project_name_3", "project_name_4", "project_name_5"],',
    '  "narrative": "2-3 sentences describing their career arc/evolution over the years.",',
    '  "strongestSkills": ["skill1", "skill2", "skill3", "skill4", "skill5"],',
    '  "uniqueTraits": ["trait1", "trait2", "trait3"]',
    '}',
    "",
    "Guidelines:",
    "- bio: NO generic phrases. Be concrete about what they build and their strongest tech.",
    "- highlights: Pick 3-5 from [primary] tier projects. Prefer: starred repos, large codebases, unique domains.",
    "- narrative: Use the yearly evolution data below to tell a story. How did their focus shift?",
    "- strongestSkills: NOT just languages. Include patterns like 'CLI tool design', 'microservice orchestration'.",
    "- uniqueTraits: What makes this developer different?",
    "",
    `Active since: ${firstYear}`,
    `Top languages: ${topLangs}`,
    `Top frameworks: ${topFw}`,
    `Total: ${projects.length} projects (${primaryCount} primary, ${secondaryCount} secondary)`,
    themesContext,
    "Projects (sorted by significance):",
    projectSummaries,
  ].join("\n");

  try {
    const result = await adapter.analyze({
      path: "", readme: "", dependencies: "", directoryTree: "", gitShortlog: "",
      recentCommits: "", rawPrompt: prompt,
    });
    const text = result.summary || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        bio: parsed.bio || "",
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
        narrative: parsed.narrative || "",
        strongestSkills: Array.isArray(parsed.strongestSkills) ? parsed.strongestSkills : [],
        uniqueTraits: Array.isArray(parsed.uniqueTraits) ? parsed.uniqueTraits : [],
      };
    }
    return { bio: text, highlights: [], narrative: "", strongestSkills: [], uniqueTraits: [] };
  } catch {
    return null;
  }
}
