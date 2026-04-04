import type { Project } from "../types.ts";

export type ProjectTier = "primary" | "secondary" | "minor";

/**
 * Calculate significance score for a project.
 * Higher = more important for the developer's portfolio.
 */
export function calculateSignificance(p: Project): number {
  let score = 0;

  // Author contribution weight
  const commits = p.authorCommitCount || 0;
  score += Math.min(commits * 0.5, 50); // cap at 50 points from commits

  // Stars (community validation)
  score += (p.stars || 0) * 10;

  // Code size
  const lines = p.size?.lines || 0;
  if (lines > 10000) score += 5;
  else if (lines > 3000) score += 3;
  else if (lines > 500) score += 1;

  // Duration (months active)
  if (p.dateRange.start && p.dateRange.end) {
    const start = new Date(p.dateRange.start).getTime();
    const end = new Date(p.dateRange.end).getTime();
    const months = (end - start) / (1000 * 60 * 60 * 24 * 30);
    if (months > 12) score += 5;
    else if (months > 3) score += 3;
    else if (months > 1) score += 1;
  }

  // Is main author (>50% of commits)
  if (p.commitCount > 0 && p.authorCommitCount / p.commitCount > 0.5) {
    score += 5;
  }

  // Has LLM analysis (means it was interesting enough to analyze)
  if (p.analysis?.summary && p.analysis.summary.length > 50) {
    score += 3;
  }

  // Tech stack diversity (more diverse = more interesting)
  const techCount = (p.analysis?.techStack?.length || 0) + p.frameworks.length;
  if (techCount > 5) score += 3;
  else if (techCount > 2) score += 1;

  // Active project bonus
  if (p.hasUncommittedChanges) score += 2;

  // Penalty for zero author commits (likely clone)
  if (p.hasGit && p.authorCommitCount === 0 && !p.hasUncommittedChanges) {
    score *= 0.1;
  }

  return Math.round(score * 10) / 10;
}

/**
 * Assign tiers based on score distribution.
 * primary: top ~15%, secondary: next ~35%, minor: rest
 */
export function assignTiers(projects: Project[]): Map<string, { score: number; tier: ProjectTier }> {
  const scored = projects.map((p) => ({
    id: p.id,
    score: calculateSignificance(p),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const total = scored.length;
  const primaryCut = Math.max(3, Math.ceil(total * 0.15));
  const secondaryCut = primaryCut + Math.max(5, Math.ceil(total * 0.35));

  const result = new Map<string, { score: number; tier: ProjectTier }>();
  for (let i = 0; i < scored.length; i++) {
    const tier: ProjectTier = i < primaryCut ? "primary" : i < secondaryCut ? "secondary" : "minor";
    result.set(scored[i].id, { score: scored[i].score, tier });
  }

  return result;
}
