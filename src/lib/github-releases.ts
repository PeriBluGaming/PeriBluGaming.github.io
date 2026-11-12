/**
 * Latest published GitHub release of a repository – build time and deploy check only, never in the browser.
 *
 * Uses GET /repos/{owner}/{repo}/releases/latest, which only ever returns a published, non-draft, non-prerelease
 * release (the one GitHub marks "Latest"). The website and the 15-minute deploy check use this same function, so the
 * check detects exactly what the pages would show. Nothing is invented: every value comes from GitHub or from the
 * live site's validated page manifest. Only the ID, version, date and release page URL are used – no assets, no history.
 *
 * Plain Node, no runtime dependencies.
 */
import { GitHubApiError } from './github.ts';
import { manifestRepoKey, trustedReleaseUrl, type ManifestRelease, type ReleaseStatus } from './page-manifest.ts';

export interface LatestRelease {
  /** GitHub's numeric release ID (stable identity; a replaced release gets a new one). */
  id: number;
  /** Tag name, e.g. "v1.2.0". */
  version: string;
  /** Release title if it differs from the tag. */
  name?: string;
  /** ISO date; absent if GitHub returned none. */
  publishedAt?: string;
  /** https://github.com/<owner>/<repo>/releases/tag/… */
  url: string;
}

const API = 'https://api.github.com';
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Validates a release API object. Returns null for anything incomplete or not on this repository's release page. */
export function normalizeRelease(data: unknown, owner: string, repo: string): LatestRelease | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.draft === true || d.prerelease === true) return null;
  if (typeof d.id !== 'number' || !Number.isSafeInteger(d.id) || d.id <= 0) return null;
  const version = typeof d.tag_name === 'string' ? d.tag_name.trim().slice(0, 100) : '';
  const url = trustedReleaseUrl(d.html_url, repo, owner);
  if (!version || !url) return null;

  const name = typeof d.name === 'string' ? d.name.trim().slice(0, 120) : '';
  const date = typeof d.published_at === 'string' && !Number.isNaN(Date.parse(d.published_at)) ? new Date(d.published_at).toISOString() : undefined;
  return { id: d.id, version, url, ...(name && name !== version && { name }), ...(date && { publishedAt: date }) };
}

/**
 * Latest release, or null when GitHub CONFIRMS there is none (404). Everything else that prevents a trustworthy
 * answer throws: network errors, timeouts, 403/429 (rate limit), 5xx, invalid JSON and unexpected release data.
 */
export async function fetchLatestRelease(
  owner: string,
  repo: string,
  { token, timeoutMs = 10_000, fetchImpl = fetch }: { token?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LatestRelease | null> {
  if (!NAME.test(owner) || !NAME.test(repo)) throw new Error(`invalid repository name "${owner}/${repo}"`);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${owner}-website-build`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
    throw new GitHubApiError(`GitHub API responded ${res.status} for ${url}`, res.status, rateLimited);
  }
  const data = await res.json();
  const release = normalizeRelease(data, owner, repo);
  if (!release) throw new GitHubApiError(`GitHub API returned unexpected release data for ${url}`, res.status);
  return release;
}

export interface ReleaseResult {
  release: LatestRelease | null;
  status: ReleaseStatus;
}

/** Stored form of a release for the page manifest. */
export const toManifestRelease = (r: LatestRelease): ManifestRelease => ({
  id: r.id,
  version: r.version,
  ...(r.name && { name: r.name }),
  url: r.url,
  ...(r.publishedAt && { publishedAt: r.publishedAt }),
});

/**
 * Build-time loader, one request per repository per build (cached):
 * 1. GitHub answers with a release → that release ("fetched").
 * 2. GitHub confirms there is none (404) → no release ("none").
 * 3. GitHub fails (or GITHUB_OFFLINE=1) → the release the live site last published for this repository, re-validated
 *    ("previous"); without one → no release ("unavailable"). The deploy guard refuses to deploy an "unavailable"
 *    page whose live version shows a release, so a GitHub outage never erases release information.
 */
export function createReleaseLoader(options: {
  owner: string;
  env: Record<string, string | undefined>;
  fetchRelease?: typeof fetchLatestRelease;
  /** Releases from the live page manifest (repository key → release), loaded only when GitHub fails. */
  previousReleases?: () => Promise<Map<string, ManifestRelease>>;
  log?: Pick<Console, 'warn'>;
}): (repo: string) => Promise<ReleaseResult> {
  const { owner, env, fetchRelease = fetchLatestRelease, previousReleases = async () => new Map(), log = console } = options;
  const cache = new Map<string, Promise<ReleaseResult>>();

  const fallback = async (repo: string, why: string): Promise<ReleaseResult> => {
    let previous: ManifestRelease | undefined;
    try {
      previous = (await previousReleases()).get(manifestRepoKey(repo));
    } catch {
      previous = undefined;
    }
    const url = previous ? trustedReleaseUrl(previous.url, repo, owner) : null;
    if (previous && url) {
      log.warn(`[releases] Latest release of ${repo} unavailable (${why}) – reusing the published ${previous.version}.`);
      const { id, version, name, publishedAt } = previous;
      return { release: { id, version, url, ...(name && { name }), ...(publishedAt && { publishedAt }) }, status: 'previous' };
    }
    log.warn(`[releases] Latest release of ${repo} unavailable (${why}) and no published release to reuse – section hidden.`);
    return { release: null, status: 'unavailable' };
  };

  return (repo) => {
    const key = manifestRepoKey(repo);
    let pending = cache.get(key);
    if (!pending) {
      pending =
        env.GITHUB_OFFLINE === '1'
          ? fallback(repo, 'GITHUB_OFFLINE=1')
          : fetchRelease(owner, repo, { token: env.GITHUB_TOKEN || undefined }).then(
              (release): ReleaseResult => ({ release, status: release ? 'fetched' : 'none' }),
              (err: unknown) => fallback(repo, err instanceof Error ? err.message : String(err)),
            );
      cache.set(key, pending);
    }
    return pending;
  };
}
