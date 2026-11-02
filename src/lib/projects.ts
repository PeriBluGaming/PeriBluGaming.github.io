import { join } from 'node:path';
import {
  categories,
  defaultCategory,
  featuredProjects,
  listSettings,
  projectOverrides,
  type Accent,
  type Category,
  type CategoryId,
  type ProjectImage,
  type ProjectOverride,
} from '../config/projects';
import { site } from '../config/site';
import fallback from '../data/fallback-repos.json';
import { fetchPublicRepos, GitHubApiError, type RepoData } from './github';
import { validateProjectImage } from './project-image';

export interface Project {
  name: string;
  title: string;
  description: string | null;
  url: string;
  category: Category;
  tags: string[];
  language: string | null;
  stars: number;
  pushedAt: string;
  fork: boolean;
  archived: boolean;
  featured: boolean;
}

export interface FeaturedProject extends Project {
  accent: Accent;
  /** Validated screenshot; absent = stylised platform art. */
  image?: ProjectImage;
}

export interface ProjectData {
  featured: FeaturedProject[];
  all: Project[];
  /** Categories that contain at least one project, in configured order. */
  categories: Category[];
  source: 'github' | 'fallback';
  fetchedAt: string;
}

const key = (name: string) => name.toLowerCase();
const categoryById = new Map(categories.map((c) => [c.id, c]));
const overrides = new Map<string, ProjectOverride>(
  Object.entries(projectOverrides).map(([name, o]) => [key(name), o]),
);
const excluded = new Set(listSettings.exclude.map(key));
const featuredOrder = new Map(featuredProjects.map((f, i) => [key(f.repo), { ...f, index: i }]));

function toProject(repo: RepoData): Project {
  const o = overrides.get(key(repo.name)) ?? {};
  const categoryId: CategoryId = o.category ?? defaultCategory;
  return {
    name: repo.name,
    title: o.title ?? repo.name,
    description: o.description ?? repo.description,
    url: repo.url,
    category: categoryById.get(categoryId) ?? categoryById.get(defaultCategory)!,
    tags: (o.tags ?? []).slice(0, 2),
    language: repo.language,
    stars: repo.stars,
    pushedAt: repo.pushedAt,
    fork: repo.fork,
    archived: repo.archived,
    featured: featuredOrder.has(key(repo.name)),
  };
}

async function loadRepos(): Promise<{ repos: RepoData[]; source: ProjectData['source']; fetchedAt: string }> {
  const useFallback = (reason: string) => {
    console.warn(`[projects] ${reason} – using fallback snapshot from ${fallback.fetchedAt}.`);
    return { repos: fallback.repos as RepoData[], source: 'fallback' as const, fetchedAt: fallback.fetchedAt };
  };

  if (process.env.GITHUB_OFFLINE === '1') return useFallback('GITHUB_OFFLINE=1');

  try {
    const repos = await fetchPublicRepos(site.githubUser, { token: process.env.GITHUB_TOKEN || undefined });
    return { repos, source: 'github', fetchedAt: new Date().toISOString() };
  } catch (err) {
    const reason =
      err instanceof GitHubApiError && err.rateLimited
        ? `GitHub rate limit reached: ${err.message}`
        : `GitHub API unavailable: ${err instanceof Error ? err.message : String(err)}`;
    return useFallback(reason);
  }
}

async function build(): Promise<ProjectData> {
  const { repos, source, fetchedAt } = await loadRepos();

  const projects = repos
    .filter((r) => !excluded.has(key(r.name)) && !overrides.get(key(r.name))?.hidden)
    .map(toProject);

  const featured: FeaturedProject[] = [];
  for (const [name, entry] of featuredOrder) {
    const project = projects.find((p) => key(p.name) === name);
    if (project) {
      const image = entry.image && validateProjectImage(entry.image, entry.repo, join(process.cwd(), 'public'));
      featured.push({ ...project, accent: entry.accent, ...(image && { image }) });
    } else console.warn(`[projects] Featured repository "${entry.repo}" is not publicly available – skipped.`);
  }

  // Featured projects bypass the fork/archive filters so they never go missing.
  const all = projects
    .filter((p) => p.featured || ((!listSettings.hideForks || !p.fork) && (!listSettings.hideArchived || !p.archived)))
    .sort(
      (a, b) =>
        (featuredOrder.get(key(a.name))?.index ?? Infinity) - (featuredOrder.get(key(b.name))?.index ?? Infinity) ||
        b.pushedAt.localeCompare(a.pushedAt),
    );

  const used = new Set(all.map((p) => p.category.id));
  return { featured, all, categories: categories.filter((c) => used.has(c.id)), source, fetchedAt };
}

// One request per build (and per dev-server session), shared by all components.
let cache: Promise<ProjectData> | undefined;
export const getProjects = (): Promise<ProjectData> => (cache ??= build());
