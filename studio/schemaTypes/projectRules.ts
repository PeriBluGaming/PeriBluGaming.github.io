/**
 * Validation rules for the `project` document type (schemaTypes/project.ts).
 * Plain TypeScript without Sanity imports (only the website's shared pure helpers), so the rules are unit-testable in Node.
 * Each function returns `true` or a message, matching Sanity's custom-validation contract.
 */
import { PROJECT_SLUG_MAX_LENGTH, isValidProjectSlug, slugifyProjectName } from '../../src/lib/project-slug.ts';
import { parseYouTubeId } from '../../src/lib/youtube.ts';

/** Characters GitHub allows in repository names. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;
export const REPO_MAX_LENGTH = 100;
export const MAX_TAGS = 2;

/** Comparison key for repository names: GitHub treats them case-insensitively. */
export const repoKey = (repo: string): string => repo.trim().toLowerCase();

/** Document ID without the draft / release-version prefix: `drafts.x` and `versions.<release>.x` → `x`. */
export function baseDocumentId(id: string): string {
  if (id.startsWith('drafts.')) return id.slice('drafts.'.length);
  const version = /^versions\.[^.]+\.(.+)$/.exec(id);
  return version ? version[1] : id;
}

export function validateRepoName(value: unknown): true | string {
  if (value === undefined || value === null || value === '') return true; // `required()` reports missing values
  if (typeof value !== 'string') return 'Must be text.';
  if (value !== value.trim()) return 'Remove leading or trailing spaces.';
  if (value.length > REPO_MAX_LENGTH) return `At most ${REPO_MAX_LENGTH} characters.`;
  if (!REPO_PATTERN.test(value)) return 'Only letters, digits, ".", "-" and "_" (the name below github.com/PeriBluGaming/).';
  if (value === '.' || value === '..') return 'Not a valid repository name.';
  return true;
}

export function validateTag(value: unknown): true | string {
  if (typeof value !== 'string' || value.trim() === '') return 'Tags must not be empty.';
  if (value !== value.trim()) return 'Remove leading or trailing spaces.';
  return true;
}

export function validateTags(value: unknown): true | string {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return 'Must be a list.';
  if (value.length > MAX_TAGS) return `At most ${MAX_TAGS} tags (the cards show two).`;
  const invalid = value.map(validateTag).find((r) => r !== true);
  if (invalid) return invalid;
  const keys = value.map((t: string) => t.trim().toLowerCase());
  if (new Set(keys).size !== keys.length) return 'Tags must be unique.';
  return true;
}

/** Complements `required()`: also rejects text that is only whitespace. */
export function validateAlt(value: unknown): true | string {
  if (value === undefined || value === null) return true; // `required()` reports missing values
  return typeof value === 'string' && value.trim() !== '' ? true : 'Describe the screenshot (alternative text is required).';
}

/** `featuredOrder` only matters for featured projects – a non-blocking hint otherwise. */
export function featuredOrderHint(order: unknown, featured: unknown): true | string {
  return order === undefined || order === null || featured === true
    ? true
    : 'Only used when "Featured" is on.';
}

/** All project documents (including drafts and release versions of other documents) with their repository. */
export const PROJECT_REPOS_QUERY = /* groq */ `*[_type == "project" && defined(repo)]{_id, repo}`;

export interface RepoLookup {
  fetch: (query: string, params: Record<string, unknown>, options: { perspective: 'raw' }) => Promise<unknown>;
}

/**
 * Case-insensitive uniqueness of `repo` across project documents. The draft, published and release versions of
 * the same document don't conflict with each other; any other document (draft or published) does.
 * Fails closed: if the lookup fails, it returns an error, so the document can't be published unchecked.
 */
export async function validateUniqueRepo(value: unknown, documentId: string | undefined, client: RepoLookup): Promise<true | string> {
  if (typeof value !== 'string' || validateRepoName(value) !== true || value === '') return true; // other rules report it
  const self = documentId ? baseDocumentId(documentId) : undefined;

  let docs: unknown;
  try {
    docs = await client.fetch(PROJECT_REPOS_QUERY, {}, { perspective: 'raw' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `Could not check whether another project already uses this repository (${reason}). Try again – publishing stays blocked until the check succeeds.`;
  }
  if (!Array.isArray(docs)) {
    return 'Could not check whether another project already uses this repository (unexpected response). Try again.';
  }

  const key = repoKey(value);
  const clash = docs.find(
    (d): d is { _id: string; repo: string } =>
      typeof d?._id === 'string' && typeof d?.repo === 'string' && baseDocumentId(d._id) !== self && repoKey(d.repo) === key,
  );
  if (!clash) return true;
  const where = clash._id.startsWith('drafts.') || clash._id.startsWith('versions.') ? 'an unpublished draft' : 'a published project';
  return `"${clash.repo}" is already used by ${where} (${baseDocumentId(clash._id)}). Repository names are compared case-insensitively.`;
}

// ── Detail pages ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Sanity slug value: `{ current }`. */
const slugValue = (value: unknown): string | undefined =>
  typeof value === 'object' && value !== null && typeof (value as { current?: unknown }).current === 'string'
    ? (value as { current: string }).current
    : undefined;

export function validateProjectSlug(value: unknown): true | string {
  const slug = slugValue(value);
  if (value === undefined || value === null || slug === undefined || slug === '') return true; // optional
  if (slug.length > PROJECT_SLUG_MAX_LENGTH) return `At most ${PROJECT_SLUG_MAX_LENGTH} characters.`;
  if (!isValidProjectSlug(slug)) return 'Only lowercase letters, digits and single hyphens (e.g. "toystory2recomp").';
  return true;
}

/** All project documents (drafts and release versions included) with a slug. */
export const PROJECT_SLUGS_QUERY = /* groq */ `*[_type == "project" && defined(slug.current)]{_id, "slug": slug.current}`;

/**
 * Slugs must be unique across project documents (published, drafts, release versions). The versions of the same
 * document don't conflict. Fails closed like the repository check. Local slugs (src/config/projects.ts →
 * detailPages) are checked too: they belong to the website's own detail-page list.
 */
export async function validateUniqueSlug(
  value: unknown,
  documentId: string | undefined,
  repo: unknown,
  client: RepoLookup,
  localPages: Record<string, string> = {},
): Promise<true | string> {
  const slug = slugValue(value);
  if (!slug || validateProjectSlug(value) !== true) return true;
  const self = documentId ? baseDocumentId(documentId) : undefined;

  const ownLocal = typeof repo === 'string' ? Object.entries(localPages).find(([r]) => repoKey(r) === repoKey(repo)) : undefined;
  if (ownLocal && ownLocal[1] !== slug) return `This project's page URL is fixed by the website configuration: "${ownLocal[1]}".`;
  const localClash = Object.entries(localPages).find(([r, s]) => s === slug && (typeof repo !== 'string' || repoKey(r) !== repoKey(repo)));
  if (localClash) return `"${slug}" is already the detail page of ${localClash[0]} (website configuration).`;

  let docs: unknown;
  try {
    docs = await client.fetch(PROJECT_SLUGS_QUERY, {}, { perspective: 'raw' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `Could not check whether another project already uses this URL (${reason}). Try again – publishing stays blocked until the check succeeds.`;
  }
  if (!Array.isArray(docs)) return 'Could not check whether another project already uses this URL (unexpected response). Try again.';
  const clash = docs.find(
    (d): d is { _id: string; slug: string } => typeof d?._id === 'string' && d?.slug === slug && baseDocumentId(d._id) !== self,
  );
  return clash ? `"${slug}" is already used by another project (${baseDocumentId(clash._id)}).` : true;
}

export function validateYouTubeUrl(value: unknown): true | string {
  if (value === undefined || value === null || value === '') return true; // `required()` reports missing values
  return parseYouTubeId(value) ? true : 'Use a YouTube video link, e.g. https://www.youtube.com/watch?v=… or https://youtu.be/….';
}

export interface DetailPageDocument {
  repo?: unknown;
  featured?: unknown;
  detailPageEnabled?: unknown;
  slug?: unknown;
}

/**
 * What the Studio's publish action adds to a project document before publishing, or null if nothing is needed.
 *
 * The page is activated permanently (`detailPageEnabled: true`) as soon as the project is featured – in the version
 * being published, in the currently published version (so un-featuring a project keeps its page), or through the
 * website's local featured list (unless Sanity explicitly sets `featured: false`). A missing slug is generated
 * once (the locally recorded slug if the website configuration has one, else from the repository name) and then
 * stored; an existing slug is never touched.
 */
export function detailPagePatch(
  next: DetailPageDocument | null | undefined,
  published: DetailPageDocument | null | undefined,
  localFeaturedRepos: readonly string[] = [],
  localPages: Record<string, string> = {},
): { detailPageEnabled?: true; slug?: { _type: 'slug'; current: string } } | null {
  if (!next) return null;
  const repo = typeof next.repo === 'string' ? next.repo.trim() : '';
  const locallyFeatured = repo !== '' && next.featured !== false && localFeaturedRepos.some((r) => repoKey(r) === repoKey(repo));
  const activate = next.featured === true || published?.featured === true || published?.detailPageEnabled === true || locallyFeatured;
  const enabled = next.detailPageEnabled === true;
  if (!activate && !enabled) return null;

  const set: { detailPageEnabled?: true; slug?: { _type: 'slug'; current: string } } = {};
  if (!enabled) set.detailPageEnabled = true;
  if (!slugValue(next.slug)) {
    const local = Object.entries(localPages).find(([r, s]) => repoKey(r) === repoKey(repo) && isValidProjectSlug(s))?.[1];
    const generated = local ?? slugifyProjectName(repo);
    if (generated) set.slug = { _type: 'slug', current: generated };
  }
  return Object.keys(set).length > 0 ? set : null;
}
