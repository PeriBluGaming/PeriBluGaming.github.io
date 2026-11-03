/**
 * Entry point for Astro pages and components: one load per build (and per dev-server session).
 */
import { readBlogConfig } from './config.ts';
import { loadBlog, type BlogData } from './load.ts';
import { fetchSanityPosts, sanityImageResolver } from './sanity.ts';

export { isBlogVisible, type BlogData } from './load.ts';
export type { BodyNode, Post, PostImage } from './normalize.ts';

let cache: Promise<BlogData> | undefined;

export const getBlog = (): Promise<BlogData> =>
  (cache ??= loadBlog(readBlogConfig(process.env), {
    fetchSanity: fetchSanityPosts,
    sanityImageResolver,
    samplePosts: async () => (await import('../../data/sample-posts.json')).default,
  }));
