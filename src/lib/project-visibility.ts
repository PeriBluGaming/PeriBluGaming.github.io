/**
 * Which `project` documents can affect the website: every published root document – no drafts.*, no versions.*
 * (unpublished release versions). Hidden documents and documents for repositories GitHub doesn't return are included:
 * they change (or may change) what is rendered.
 *
 * Single source of truth for the project query (src/lib/sanity-projects.ts) and the deploy fingerprint
 * (src/lib/content-fingerprint.ts). Free of runtime dependencies so the deploy check can run without `npm ci`.
 */
export const PROJECT_DOCUMENT_FILTER = `_type == "project" && _id in path("*")`;
