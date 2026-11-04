/**
 * Project data pipeline: GitHub repositories (live API, fallback snapshot) + optional Sanity overrides + local
 * configuration → featured and listed projects. Sources are injected so the pipeline is testable without network;
 * src/lib/projects.ts wires the real ones.
 *
 * A CMS problem never breaks the site: without Sanity configuration, on API errors or invalid responses the local
 * configuration is used as before (with a warning). An empty project collection is valid and not an error.
 */
import type { Category, ProjectImage } from '../config/projects.ts';
import type { BlogConfig } from './blog/config.ts';
import type { ContentItem } from './content-fingerprint.ts';
import { GitHubApiError, type RepoData } from './github.ts';
import {
  mergeProjects,
  normalizeSanityProject,
  selectOverrides,
  type EditorialOverride,
  type FeaturedProject,
  type MergeConfig,
  type Project,
} from './project-merge.ts';

export type SanityProjectsStatus = 'disabled' | 'sanity' | 'unavailable';

export interface ProjectData {
  featured: FeaturedProject[];
  all: Project[];
  /** Categories that contain at least one project, in configured order. */
  categories: Category[];
  source: 'github' | 'fallback';
  fetchedAt: string;
  /** Whether Sanity overrides were applied ("sanity"), not configured or unavailable (local configuration only). */
  overrides: SanityProjectsStatus;
  /**
   * Type, ID and revision of every project document Sanity returned (before validation) – input for the deploy
   * fingerprint. Only set when overrides is "sanity"; a failed fetch never yields an (empty) list.
   */
  contentItems?: ContentItem[];
}

type SanityConfig = Extract<BlogConfig, { mode: 'sanity' }>;

export interface ProjectSources {
  env: Record<string, string | undefined>;
  config: MergeConfig;
  githubUser: string;
  fallback: { fetchedAt: string; repos: RepoData[] };
  fetchRepos: (user: string, options: { token?: string }) => Promise<RepoData[]>;
  /** Sanity settings (shared with the blog); mode "sanity" enables overrides. */
  sanityConfig: BlogConfig;
  fetchSanityProjects: (config: SanityConfig) => Promise<unknown>;
  screenshotResolver: (config: SanityConfig) => (shot: unknown) => ProjectImage | null;
  resolveLocalImage: (image: ProjectImage, repo: string) => ProjectImage;
  log?: Pick<Console, 'warn'>;
}

async function loadRepos(s: ProjectSources): Promise<{ repos: RepoData[]; source: ProjectData['source']; fetchedAt: string }> {
  const log = s.log ?? console;
  const useFallback = (reason: string) => {
    log.warn(`[projects] ${reason} – using fallback snapshot from ${s.fallback.fetchedAt}.`);
    return { repos: s.fallback.repos, source: 'fallback' as const, fetchedAt: s.fallback.fetchedAt };
  };

  if (s.env.GITHUB_OFFLINE === '1') return useFallback('GITHUB_OFFLINE=1');

  try {
    const repos = await s.fetchRepos(s.githubUser, { token: s.env.GITHUB_TOKEN || undefined });
    return { repos, source: 'github', fetchedAt: new Date().toISOString() };
  } catch (err) {
    const reason =
      err instanceof GitHubApiError && err.rateLimited
        ? `GitHub rate limit reached: ${err.message}`
        : `GitHub API unavailable: ${err instanceof Error ? err.message : String(err)}`;
    return useFallback(reason);
  }
}

async function loadOverrides(
  s: ProjectSources,
): Promise<{ status: SanityProjectsStatus; overrides: Map<string, EditorialOverride>; contentItems?: ContentItem[] }> {
  const log = s.log ?? console;
  const none = (status: SanityProjectsStatus) => ({ status, overrides: new Map<string, EditorialOverride>() });
  const config = s.sanityConfig;
  if (config.mode !== 'sanity') return none('disabled');

  let raw: unknown;
  try {
    raw = await s.fetchSanityProjects(config);
  } catch (err) {
    log.warn(`[projects] Sanity projects unavailable (${err instanceof Error ? err.message : String(err)}) – using the local project configuration.`);
    return none('unavailable');
  }
  if (!Array.isArray(raw)) {
    log.warn('[projects] Sanity returned an unexpected response for projects – using the local project configuration.');
    return none('unavailable');
  }

  const resolveImage = s.screenshotResolver(config);
  const categoryIds = new Set(s.config.categories.map((c) => c.id));
  const valid: EditorialOverride[] = [];
  for (const doc of raw) {
    const { override, warnings } = normalizeSanityProject(doc, { categoryIds, resolveImage });
    warnings.forEach((w) => log.warn(`[projects] ${w}`));
    if (override) valid.push(override);
  }
  const { byKey, warnings } = selectOverrides(valid);
  warnings.forEach((w) => log.warn(`[projects] ${w}`));
  const contentItems = raw.map((doc) => {
    const d = (doc ?? {}) as Record<string, unknown>;
    return { _type: 'project', _id: String(d._id ?? ''), _rev: String(d._rev ?? '') };
  });
  return { status: 'sanity', overrides: byKey, contentItems };
}

export async function buildProjectData(s: ProjectSources): Promise<ProjectData> {
  const log = s.log ?? console;
  const [{ repos, source, fetchedAt }, { status, overrides, contentItems }] = await Promise.all([loadRepos(s), loadOverrides(s)]);
  const { featured, all, categories, warnings } = mergeProjects({ repos, overrides, config: s.config, resolveLocalImage: s.resolveLocalImage });
  warnings.forEach((w) => log.warn(`[projects] ${w}`));
  return { featured, all, categories, source, fetchedAt, overrides: status, ...(contentItems && { contentItems }) };
}
