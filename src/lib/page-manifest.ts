/**
 * Published page manifest – /projects/pages.json – and the deployment guard built on it.
 *
 * Every build publishes the list of project detail pages it rendered (repository → slug) together with the latest
 * release each page showed. The manifest of the LIVE site is the persistent record of what is published:
 * - builds keep every page and slug the live site has (src/lib/project-pages.ts), and reuse its releases when GitHub
 *   is temporarily unavailable (src/lib/github-releases.ts);
 * - the deploy workflow refuses a build that would remove a published page, change its slug, give a published slug to
 *   another repository or erase a release it can't re-confirm (compareManifests, scripts/deploy-check.ts).
 *
 * Plain Node, no runtime dependencies (the check job runs without `npm ci`); network access is injected for tests.
 */

export const MANIFEST_PATH = '/projects/pages.json';
export const MANIFEST_SCHEMA = 1;

const OWNER = 'PeriBluGaming';
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 96;

/** Comparison key for repository names: GitHub treats them case-insensitively. */
export const manifestRepoKey = (repo: string): string => repo.trim().toLowerCase();

export interface ManifestRelease {
  /** GitHub's numeric release ID – changes when a release is replaced, even with the same tag. */
  id: number;
  version: string;
  /** Release title if it differs from the tag. */
  name?: string;
  url: string;
  publishedAt?: string;
}

/**
 * Where the page's release information came from:
 * fetched – current GitHub response · none – GitHub confirmed there is no published release ·
 * previous – GitHub unavailable, reused from the live manifest · unavailable – GitHub unavailable, nothing to reuse.
 */
export type ReleaseStatus = 'fetched' | 'none' | 'previous' | 'unavailable';

export interface ManifestPage {
  repo: string;
  slug: string;
  release: ManifestRelease | null;
  releaseStatus: ReleaseStatus;
}

export interface PageManifest {
  schemaVersion: number;
  pages: ManifestPage[];
}

const RELEASE_STATUSES: readonly ReleaseStatus[] = ['fetched', 'none', 'previous', 'unavailable'];

/** Release page URL of exactly this repository on github.com, or null. Shared with src/lib/github-releases.ts. */
export function trustedReleaseUrl(value: unknown, repo: string, owner = OWNER): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const prefix = `/${owner}/${repo}/releases/`.toLowerCase();
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return null;
  if (!url.pathname.toLowerCase().startsWith(prefix) || url.pathname.length <= prefix.length) return null;
  return url.href;
}

/** Validates a stored release for `repo`; anything doubtful → null (never reused). */
export function parseManifestRelease(value: unknown, repo: string): ManifestRelease | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'number' || !Number.isSafeInteger(r.id) || r.id <= 0) return null;
  const version = typeof r.version === 'string' ? r.version.trim() : '';
  if (!version || version.length > 100) return null;
  const url = trustedReleaseUrl(r.url, repo);
  if (!url) return null;
  const publishedAt = typeof r.publishedAt === 'string' && !Number.isNaN(Date.parse(r.publishedAt)) ? r.publishedAt : undefined;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 120) : '';
  return { id: r.id, version, ...(name && name !== version && { name }), url, ...(publishedAt && { publishedAt }) };
}

export function createManifest(pages: ManifestPage[]): PageManifest {
  const sorted = [...pages].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { schemaVersion: MANIFEST_SCHEMA, pages: sorted };
}

/**
 * Strict parser: the whole manifest is rejected if anything is malformed or inconsistent (unknown schema, invalid
 * repository or slug, duplicate repository or slug, a release that is not this repository's github.com release page,
 * a release status that contradicts the release).
 */
export function parseManifest(json: unknown): { ok: true; manifest: PageManifest } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return fail('not an object');
  const m = json as Record<string, unknown>;
  if (m.schemaVersion !== MANIFEST_SCHEMA) return fail(`unsupported schemaVersion ${JSON.stringify(m.schemaVersion)}`);
  if (!Array.isArray(m.pages)) return fail('pages is not a list');

  const pages: ManifestPage[] = [];
  const repos = new Set<string>();
  const slugs = new Set<string>();
  for (const [i, raw] of m.pages.entries()) {
    if (typeof raw !== 'object' || raw === null) return fail(`page #${i + 1} is not an object`);
    const p = raw as Record<string, unknown>;
    if (typeof p.repo !== 'string' || !REPO.test(p.repo)) return fail(`page #${i + 1} has an invalid repository`);
    if (typeof p.slug !== 'string' || p.slug.length > SLUG_MAX || !SLUG.test(p.slug)) return fail(`page ${p.repo} has an invalid slug`);
    if (repos.has(manifestRepoKey(p.repo))) return fail(`repository ${p.repo} is listed twice`);
    if (slugs.has(p.slug)) return fail(`slug "${p.slug}" is used twice`);
    if (!RELEASE_STATUSES.includes(p.releaseStatus as ReleaseStatus)) return fail(`page ${p.repo} has an invalid release status`);
    const status = p.releaseStatus as ReleaseStatus;
    let release: ManifestRelease | null = null;
    if (p.release !== null) {
      release = parseManifestRelease(p.release, p.repo);
      if (!release) return fail(`page ${p.repo} has an invalid release`);
    }
    const needsRelease = status === 'fetched' || status === 'previous';
    if (needsRelease !== (release !== null)) return fail(`page ${p.repo}: release status "${status}" contradicts its release`);
    repos.add(manifestRepoKey(p.repo));
    slugs.add(p.slug);
    pages.push({ repo: p.repo, slug: p.slug, release, releaseStatus: status });
  }
  return { ok: true, manifest: { schemaVersion: MANIFEST_SCHEMA, pages } };
}

export type LiveManifest = { state: 'found'; manifest: PageManifest } | { state: 'missing' } | { state: 'unreadable'; reason: string };

/**
 * The live site's manifest. Only a real HTTP 404 counts as "missing"; network errors, timeouts, other statuses and
 * invalid JSON or content are "unreadable" – never mistaken for "no pages yet". Bypasses the Pages CDN cache.
 */
export async function fetchLiveManifest(siteUrl: string, { fetchImpl = fetch, timeoutMs = 15_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<LiveManifest> {
  const url = new URL(MANIFEST_PATH, siteUrl);
  url.searchParams.set('nocache', String(Date.now()));
  try {
    const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return { state: 'missing' };
    if (!res.ok) return { state: 'unreadable', reason: `HTTP ${res.status}` };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { state: 'unreadable', reason: 'invalid JSON' };
    }
    const parsed = parseManifest(json);
    return parsed.ok ? { state: 'found', manifest: parsed.manifest } : { state: 'unreadable', reason: `invalid manifest (${parsed.reason})` };
  } catch (err) {
    return { state: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/** What the live /build-info.json says about manifests (see src/lib/deploy-check.ts). */
export type LiveSiteState = 'uses-manifest' | 'pre-manifest' | 'no-site' | 'unknown';

/**
 * Deterministic bootstrap. A missing live manifest is accepted ONLY when the live build info proves the site predates
 * manifests (readable build-info.json without the `manifest` field), or when the site has never been published (no
 * build-info.json and no manifest). Every other combination with a missing or unreadable manifest is refused.
 */
export function resolveLiveManifest(site: LiveSiteState, live: LiveManifest): { state: 'compare'; manifest: PageManifest } | { state: 'bootstrap'; reason: string } | { state: 'refuse'; reason: string } {
  if (live.state === 'found') return { state: 'compare', manifest: live.manifest };
  if (live.state === 'unreadable') return { state: 'refuse', reason: `live ${MANIFEST_PATH} is unreadable (${live.reason})` };
  if (site === 'pre-manifest') return { state: 'bootstrap', reason: 'first page manifest: the live site was built before manifests existed' };
  if (site === 'no-site') return { state: 'bootstrap', reason: 'first publication of the site' };
  if (site === 'uses-manifest') return { state: 'refuse', reason: `live site declares a page manifest but ${MANIFEST_PATH} returned 404` };
  return { state: 'refuse', reason: `live ${MANIFEST_PATH} is missing and the live build info could not be read – cannot tell a first publication from an outage` };
}

/**
 * Deployment guard. Every live page must still exist under the same slug; no live slug may move to another
 * repository; a release the live site shows may not disappear because GitHub was unavailable during the build.
 * The only permitted removal: an entry in `retired` (src/config/projects.ts → retiredDetailPages) with the same
 * repository AND slug – an explicit, reviewed code change. Not being featured or hidden is never enough.
 */
export function compareManifests(input: { live: PageManifest; next: PageManifest; retired?: Record<string, string> }): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const retired = new Map(Object.entries(input.retired ?? {}).map(([repo, slug]) => [manifestRepoKey(repo), slug]));
  const nextByRepo = new Map(input.next.pages.map((p) => [manifestRepoKey(p.repo), p]));
  const nextBySlug = new Map(input.next.pages.map((p) => [p.slug, p]));

  for (const live of input.live.pages) {
    const key = manifestRepoKey(live.repo);
    const next = nextByRepo.get(key);
    const owner = nextBySlug.get(live.slug);
    if (owner && manifestRepoKey(owner.repo) !== key) {
      problems.push(`published slug "${live.slug}" (${live.repo}) would be reassigned to ${owner.repo}`);
    }
    if (!next) {
      if (retired.get(key) === live.slug) continue;
      problems.push(`published page ${live.repo} (/projects/${live.slug}/) would disappear`);
      continue;
    }
    if (next.slug !== live.slug) problems.push(`published page ${live.repo} would move from "${live.slug}" to "${next.slug}"`);
    if (live.release && next.releaseStatus === 'unavailable') {
      problems.push(`release ${live.release.version} of ${live.repo} would disappear (GitHub was unavailable during the build)`);
    }
  }
  return { ok: problems.length === 0, problems };
}
