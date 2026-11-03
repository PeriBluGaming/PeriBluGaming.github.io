/**
 * Decides where blog posts come from, based on build-time environment variables.
 *
 *   BLOG_SAMPLE=1        → local sample posts (src/data/sample-posts.json), for development only
 *   SANITY_PROJECT_ID    → posts from Sanity (published documents only)
 *   neither              → blog deliberately not configured: no posts, no "Blog" menu item
 *
 * Pure function of the env record, so it can be unit-tested without Astro.
 */

export type BlogConfig =
  | { mode: 'disabled' }
  | { mode: 'sample' }
  | {
      mode: 'sanity';
      projectId: string;
      dataset: string;
      apiVersion: string;
      /** Only needed for a private dataset. Build time only – never exposed to the browser. */
      token?: string;
      /** SANITY_ALLOW_FAILURE=1: build without posts if Sanity is unreachable instead of failing. */
      allowFailure: boolean;
    };

export class BlogConfigError extends Error {
  constructor(message: string) {
    super(`[blog] ${message}`);
    this.name = 'BlogConfigError';
  }
}

export const DEFAULT_DATASET = 'production';
/** Pinned Sanity API version (a date). Bump deliberately, see docs/sanity-setup.md. */
export const DEFAULT_API_VERSION = '2025-02-19';

const PROJECT_ID = /^[a-z0-9]+$/;
const DATASET = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const API_VERSION = /^\d{4}-\d{2}-\d{2}$/;

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string) => env[name]?.trim() || undefined;
const flag = (env: Env, name: string) => value(env, name) === '1';

export function readBlogConfig(env: Env): BlogConfig {
  if (flag(env, 'BLOG_SAMPLE')) {
    // Sample posts are fake content – they must never reach the live site.
    if (env.GITHUB_ACTIONS === 'true' || env.CI === 'true') {
      throw new BlogConfigError('BLOG_SAMPLE=1 is for local development only and is refused in CI builds.');
    }
    return { mode: 'sample' };
  }

  const projectId = value(env, 'SANITY_PROJECT_ID');
  if (!projectId) return { mode: 'disabled' };

  const dataset = value(env, 'SANITY_DATASET') ?? DEFAULT_DATASET;
  const apiVersion = value(env, 'SANITY_API_VERSION') ?? DEFAULT_API_VERSION;
  const token = value(env, 'SANITY_READ_TOKEN');

  if (!PROJECT_ID.test(projectId)) {
    throw new BlogConfigError(`SANITY_PROJECT_ID must contain only lowercase letters and digits (got "${projectId}").`);
  }
  if (!DATASET.test(dataset)) {
    throw new BlogConfigError(`SANITY_DATASET is not a valid dataset name (got "${dataset}").`);
  }
  if (!API_VERSION.test(apiVersion)) {
    throw new BlogConfigError(`SANITY_API_VERSION must be a date like ${DEFAULT_API_VERSION} (got "${apiVersion}").`);
  }

  return {
    mode: 'sanity',
    projectId,
    dataset,
    apiVersion,
    ...(token && { token }),
    allowFailure: flag(env, 'SANITY_ALLOW_FAILURE'),
  };
}
