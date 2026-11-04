/**
 * Which post documents are visible on the website.
 *
 * Single source of truth for the blog query (src/lib/blog/sanity.ts) and the deploy fingerprint
 * (src/lib/content-fingerprint.ts), so "what the build renders" and "what triggers a deploy" never drift apart.
 * Kept free of runtime dependencies so the deploy check can run without `npm ci`.
 *
 * - root-path documents only: no drafts.*, versions.* (unpublished release versions) or other namespaces
 * - a slug, not hidden, publish date reached (scheduled posts become visible with a later build)
 */
export const POST_VISIBLE_FILTER = `_type == "post" && _id in path("*") && defined(slug.current) && hidden != true && publishedAt <= now()`;
