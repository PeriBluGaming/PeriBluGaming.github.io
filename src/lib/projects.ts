import { join } from 'node:path';
import { categories, defaultCategory, featuredProjects, listSettings, projectOverrides } from '../config/projects';
import { site } from '../config/site';
import fallback from '../data/fallback-repos.json';
import { readBlogConfig, type BlogConfig } from './blog/config';
import { fetchPublicRepos, type RepoData } from './github';
import { buildProjectData, type ProjectData } from './project-data';
import { validateProjectImage } from './project-image';
import { fetchSanityProjects, sanityScreenshotResolver } from './sanity-projects';

export type { FeaturedProject, Project } from './project-merge';
export type { ProjectData } from './project-data';

/** Same Sanity project/dataset/token settings as the blog. Invalid settings → local configuration only. */
function sanityConfig(): BlogConfig {
  try {
    return readBlogConfig(process.env);
  } catch (err) {
    console.warn(`[projects] ${err instanceof Error ? err.message : String(err)} – using the local project configuration.`);
    return { mode: 'disabled' };
  }
}

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
  }));
