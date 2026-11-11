/**
 * Latest published GitHub release of a repository – build time only, never in the browser.
 *
 * Uses GET /repos/{owner}/{repo}/releases/latest, which only ever returns a published, non-draft, non-prerelease
 * release. Nothing is invented: no release (404) or anything unexpected → null, and the page hides the section.
 * Only the version, date and release page URL are used – no assets, no history.
 * Free of Astro imports so `node --test` can load it.
 */
import { GitHubApiError } from './github.ts';

export interface LatestRelease {
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

/** Validates a release API object. The URL must be this repository's release page on github.com. */
export function normalizeRelease(data: unknown, owner: string, repo: string): LatestRelease | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.draft === true || d.prerelease === true) return null;
  const version = typeof d.tag_name === 'string' ? d.tag_name.trim().slice(0, 100) : '';
  if (!version || typeof d.html_url !== 'string') return null;

  let url: URL;
  try {
    url = new URL(d.html_url);
  } catch {
    return null;
  }
  const prefix = `/${owner}/${repo}/releases/`.toLowerCase();
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.toLowerCase().startsWith(prefix)) return null;

  const name = typeof d.name === 'string' ? d.name.trim().slice(0, 120) : '';
  const date = typeof d.published_at === 'string' && !Number.isNaN(Date.parse(d.published_at)) ? new Date(d.published_at).toISOString() : undefined;
  return { version, url: url.href, ...(name && name !== version && { name }), ...(date && { publishedAt: date }) };
}

/** Latest release, or null if the repository has none. Throws GitHubApiError / network errors otherwise. */
export async function fetchLatestRelease(
  owner: string,
  repo: string,
  { token, timeoutMs = 10_000, fetchImpl = fetch }: { token?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LatestRelease | null> {
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
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
  return normalizeRelease(await res.json(), owner, repo);
}

/**
 * Build-safe loader: GITHUB_OFFLINE=1 skips the API; any error is logged and treated as "no release", so a GitHub
 * outage or rate limit only hides the release section instead of failing the build. One request per repository
 * per build (cached).
 */
export function createReleaseLoader(options: {
  owner: string;
  env: Record<string, string | undefined>;
  fetchRelease?: typeof fetchLatestRelease;
  log?: Pick<Console, 'warn'>;
}): (repo: string) => Promise<LatestRelease | null> {
  const { owner, env, fetchRelease = fetchLatestRelease, log = console } = options;
  const cache = new Map<string, Promise<LatestRelease | null>>();
  return (repo) => {
    if (env.GITHUB_OFFLINE === '1') return Promise.resolve(null);
    const key = repo.toLowerCase();
    let pending = cache.get(key);
    if (!pending) {
      pending = fetchRelease(owner, repo, { token: env.GITHUB_TOKEN || undefined }).catch((err: unknown) => {
        log.warn(`[releases] Latest release of ${repo} unavailable (${err instanceof Error ? err.message : String(err)}) – section hidden.`);
        return null;
      });
      cache.set(key, pending);
    }
    return pending;
  };
}
