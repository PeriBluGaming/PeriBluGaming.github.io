/**
 * Loads and validates all blog posts for one build.
 *
 * Error handling distinguishes three situations on purpose:
 * - CMS not configured (no SANITY_PROJECT_ID)  → status "disabled": no posts, blog hidden from the menu. Not an error.
 * - CMS configured, request fails             → the build FAILS with BlogSourceError. GitHub Pages keeps serving the
 *                                                previous deployment, so a Sanity outage can never silently publish a
 *                                                site without its posts.
 *   … unless SANITY_ALLOW_FAILURE=1            → status "unavailable": build continues without posts, with a loud warning.
 * - Single broken documents                    → skipped with a warning; the remaining posts are still published.
 *
 * Data sources are injected, so the logic is unit-testable without network access.
 */
import { blogCategories, type BlogCategory } from '../../config/blog.ts';
import type { BlogConfig } from './config.ts';
import { localImageResolver, normalizePost, type ImageResolver, type Post } from './normalize.ts';

export type BlogStatus = 'disabled' | 'sample' | 'sanity' | 'unavailable';

export interface BlogData {
  status: BlogStatus;
  /** Newest first. */
  posts: Post[];
  /** Categories that contain at least one post, in configured order. */
  categories: BlogCategory[];
  warnings: string[];
}

export interface BlogSources {
  /** Raw post documents from Sanity. Should throw on any transport or API error. */
  fetchSanity: (config: Extract<BlogConfig, { mode: 'sanity' }>) => Promise<unknown>;
  sanityImageResolver: (config: Extract<BlogConfig, { mode: 'sanity' }>) => ImageResolver;
  /** Raw sample documents (src/data/sample-posts.json). */
  samplePosts: () => Promise<unknown>;
  now?: () => Date;
  log?: Pick<Console, 'info' | 'warn'>;
}

export class BlogSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`[blog] ${message}`, options);
    this.name = 'BlogSourceError';
  }
}

/** The blog (menu item, listing) is only shown when there is real content to show. */
export const isBlogVisible = (data: Pick<BlogData, 'status' | 'posts'>): boolean =>
  (data.status === 'sanity' || data.status === 'sample') && data.posts.length > 0;

export function processPosts(raw: unknown, resolve: ImageResolver, now: Date): { posts: Post[]; warnings: string[] } {
  if (!Array.isArray(raw)) throw new BlogSourceError('expected an array of posts from the data source.');

  const warnings: string[] = [];
  const bySlug = new Map<string, Post>();

  for (const doc of raw) {
    const result = normalizePost(doc, resolve);
    if (!result.ok) {
      warnings.push(`${result.reason} – skipped`);
      continue;
    }
    warnings.push(...result.warnings);
    const { post } = result;
    if (Date.parse(post.publishedAt) > now.getTime()) continue; // scheduled: appears with a later build
    if (bySlug.has(post.slug)) {
      warnings.push(`post ${post.id}: slug "${post.slug}" is already used by ${bySlug.get(post.slug)!.id} – skipped`);
      continue;
    }
    bySlug.set(post.slug, post);
  }

  const posts = [...bySlug.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  // Links to posts that are not part of this build (hidden, scheduled, invalid) become plain text –
  // no dead links and no hints at unpublished slugs.
  for (const post of posts) {
    for (const node of post.body) {
      if (node._type !== 'block') continue;
      for (const def of node.markDefs) {
        const slug = def.href?.match(/^\/blog\/([a-z0-9-]+)\/$/)?.[1];
        if (slug && !bySlug.has(slug)) {
          def.href = null;
          warnings.push(`post ${post.id}: link to unavailable post "${slug}" rendered as text`);
        }
      }
    }
  }
  return { posts, warnings };
}

const withCategories = (status: BlogStatus, posts: Post[], warnings: string[]): BlogData => {
  const used = new Set(posts.map((p) => p.category.id));
  return { status, posts, categories: blogCategories.filter((c) => used.has(c.id)), warnings };
};

export async function loadBlog(config: BlogConfig, sources: BlogSources): Promise<BlogData> {
  const log = sources.log ?? console;
  const now = sources.now?.() ?? new Date();

  if (config.mode === 'disabled') {
    log.info('[blog] Sanity is not configured (SANITY_PROJECT_ID unset) – blog is hidden.');
    return withCategories('disabled', [], []);
  }

  if (config.mode === 'sample') {
    log.warn('[blog] BLOG_SAMPLE=1 – using local sample posts. Never use this for a production build.');
    const { posts, warnings } = processPosts(await sources.samplePosts(), localImageResolver, now);
    warnings.forEach((w) => log.warn(`[blog] ${w}`));
    return withCategories('sample', posts, warnings);
  }

  let raw: unknown;
  try {
    raw = await sources.fetchSanity(config);
    if (!Array.isArray(raw)) throw new Error('response is not an array');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = `Could not load posts from Sanity (project ${config.projectId}, dataset ${config.dataset}): ${reason}`;
    if (!config.allowFailure) {
      throw new BlogSourceError(
        `${message}\nThe build was stopped so the live site keeps its current posts. ` +
          'Set SANITY_ALLOW_FAILURE=1 to build without posts on purpose.',
        { cause: err },
      );
    }
    log.warn(`[blog] ${message}\n[blog] SANITY_ALLOW_FAILURE=1 – building WITHOUT blog posts.`);
    return withCategories('unavailable', [], [message]);
  }

  const { posts, warnings } = processPosts(raw, sources.sanityImageResolver(config), now);
  warnings.forEach((w) => log.warn(`[blog] ${w}`));
  log.info(`[blog] Loaded ${posts.length} published post(s) from Sanity.`);
  return withCategories('sanity', posts, warnings);
}
