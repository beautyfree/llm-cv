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
    "- focus: What was the developer exploring or building that year? Write like a human, one clear sentence.",
    "- Cover ALL significant areas, not just the dominant one. If they did Web3 AND AI in 2024, mention both.",
    "- topProjects: 1-3 most interesting/significant projects of that year. Pick from different areas.",
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
    "You are writing a developer's portfolio page. A real person will read this.",
    "Respond with ONLY a JSON object.",
    "",
    '{',
    '  "bio": "3-4 sentences",',
    '  "highlights": {"2024": ["proj1", "proj2"], "2023": ["proj3", "proj4"], "2022": ["proj5"]},',
    '  "narrative": "2-3 sentences",',
    '  "strongestSkills": ["skill1", "skill2", "skill3", "skill4", "skill5"],',
    '  "uniqueTraits": ["trait1", "trait2", "trait3"]',
    '}',
    "",
    "CRITICAL RULES:",
    "",
    "bio:",
    "- Write like a human, not a technical spec. A recruiter or founder should understand it.",
    "- BAD: 'ships React/Vite clients with typed OpenAPI contracts alongside containerized TypeScript microservices on GKE'",
    "- GOOD: 'Full-stack engineer who builds and ships real products, from mobile apps to backend infrastructure'",
    "- Mention the BREADTH of their work, not just one domain. This person has " + projects.length + " projects across many areas.",
    "- Third person. No buzzwords. No jargon stacking.",
    "",
    "highlights:",
    "- Object with year keys. Pick 1-3 best projects PER YEAR for years that have meaningful work.",
    "- Show range: different domains across years.",
    "- Prefer: high impactScore, starred repos, unique/interesting purpose.",
    "- Do NOT pick multiple projects from the same mono-repo in one year.",
    "- Only include years where there are genuine standout projects.",
    "",
    "narrative:",
    "- Tell the career STORY using the yearly evolution data. How did interests evolve?",
    "- Cover the full timeline, not just recent years.",
    "- Write for a person, not a machine. Short, clear sentences.",
    "",
    "strongestSkills:",
    "- Mix levels: 2 broad (e.g. 'full-stack web development'), 2 specific (e.g. 'real-time data pipelines'), 1 soft (e.g. 'shipping end-to-end products solo').",
    "- NOT just framework names. Describe CAPABILITIES.",
    "",
    "uniqueTraits:",
    "- What would surprise someone looking at this portfolio? Keep each under 15 words.",
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
      // highlights can be { "2024": ["a", "b"], "2023": ["c"] } or flat ["a", "b"]
      let highlights: string[] = [];
      if (parsed.highlights && typeof parsed.highlights === "object" && !Array.isArray(parsed.highlights)) {
        // Per-year format — flatten to array but keep in yearly order (newest first)
        const years = Object.keys(parsed.highlights).sort((a, b) => b.localeCompare(a));
        for (const year of years) {
          const yearProjects = parsed.highlights[year];
          if (Array.isArray(yearProjects)) highlights.push(...yearProjects);
        }
      } else if (Array.isArray(parsed.highlights)) {
        highlights = parsed.highlights;
      }

      // Preserve per-year structure if available
      const highlightsByYear: Record<string, string[]> = {};
      if (parsed.highlights && typeof parsed.highlights === "object" && !Array.isArray(parsed.highlights)) {
        for (const [year, projs] of Object.entries(parsed.highlights)) {
          if (Array.isArray(projs)) highlightsByYear[year] = projs;
        }
      }

      return {
        bio: parsed.bio || "",
        highlights,
        highlightsByYear: Object.keys(highlightsByYear).length > 0 ? highlightsByYear : undefined,
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
