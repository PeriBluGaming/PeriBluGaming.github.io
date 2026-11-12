import { join } from 'node:path';
import { categories, defaultCategory, detailPages, featuredProjects, listSettings, projectOverrides, retiredDetailPages } from '../config/projects';
import { site } from '../config/site';
import fallback from '../data/fallback-repos.json';
import { readBlogConfig, type BlogConfig } from './blog/config';
import { sanityImageResolver } from './blog/sanity';
import { fetchPublicRepos, type RepoData } from './github';
import { createReleaseLoader } from './github-releases';
import { fetchLiveManifest, manifestRepoKey, type LiveManifest } from './page-manifest';
import { buildProjectData, type ProjectData } from './project-data';
import { validateProjectImage } from './project-image';
import { fetchSanityProjects, sanityScreenshotResolver } from './sanity-projects';

export type { FeaturedProject, Project } from './project-merge';
export type { ProjectData } from './project-data';
export type { ProjectPage } from './project-pages';
export type { LatestRelease, ReleaseResult } from './github-releases';

/** Same Sanity project/dataset/token settings as the blog. Invalid settings → local configuration only. */
function sanityConfig(): BlogConfig {
  try {
    return readBlogConfig(process.env);
  } catch (err) {
    console.warn(`[projects] ${err instanceof Error ? err.message : String(err)} – using the local project configuration.`);
    return { mode: 'disabled' };
  }
}

/**
 * The live site's page manifest, read once per build: published pages and slugs are kept, published releases are
 * reused when GitHub fails. If it can't be read, the build continues without it and the deploy guard (which reads it
 * again) refuses any build that would drop or change a published page. PAGES_MANIFEST_OFFLINE=1 skips the request.
 */
let liveManifest: Promise<LiveManifest> | undefined;
export const getLiveManifest = (): Promise<LiveManifest> =>
  (liveManifest ??=
    process.env.PAGES_MANIFEST_OFFLINE === '1'
      ? Promise.resolve({ state: 'unreadable', reason: 'PAGES_MANIFEST_OFFLINE=1' } as const)
      : fetchLiveManifest(site.url).then((live) => {
          if (live.state === 'unreadable') console.warn(`[projects] Live page manifest unreadable (${live.reason}) – published pages are not pre-loaded; the deploy guard checks them.`);
          return live;
        }));

const livePages = async () => {
  const live = await getLiveManifest();
  return live.state === 'found' ? Object.fromEntries(live.manifest.pages.map((p) => [p.repo, p.slug])) : {};
};

// One request per source per build (and per dev-server session), shared by all components.
let cache: Promise<ProjectData> | undefined;
export const getProjects = (): Promise<ProjectData> =>
  (cache ??= buildProjectData({
    env: process.env,
    config: { categories, defaultCategory, projectOverrides, featuredProjects, listSettings },
    githubUser: site.githubUser,
    fallback: { fetchedAt: fallback.fetchedAt, repos: fallback.repos as RepoData[] },
    fetchRepos: fetchPublicRepos,
    // BLOG_SAMPLE or no project ID → local configuration only.
    sanityConfig: sanityConfig(),
    fetchSanityProjects,
    screenshotResolver: sanityScreenshotResolver,
    resolveLocalImage: (image, repo) => validateProjectImage(image, repo, join(process.cwd(), 'public')),
    detailPages,
    retiredPages: retiredDetailPages,
    publishedPages: livePages,
    detailImageResolver: sanityImageResolver,
  }));

/** Latest published GitHub release per repository (cached; GitHub errors → last published release, never a failed build). */
export const getReleaseResult = createReleaseLoader({
  owner: site.githubUser,
  env: process.env,
  previousReleases: async () => {
    const live = await getLiveManifest();
    const pages = live.state === 'found' ? live.manifest.pages : [];
    return new Map(pages.flatMap((p) => (p.release ? [[manifestRepoKey(p.repo), p.release] as const] : [])));
  },
});

export const getLatestRelease = async (repo: string) => (await getReleaseResult(repo)).release;
