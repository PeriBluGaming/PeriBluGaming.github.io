/**
 * Minimal GitHub REST client for public repository data.
 * Runs at build time only (Astro frontmatter / Node scripts) – never in the browser.
 * Kept free of Astro imports so `scripts/update-fallback.ts` can reuse it.
 */

export interface RepoData {
  name: string;
  url: string;
  description: string | null;
  language: string | null;
  stars: number;
  fork: boolean;
  archived: boolean;
  pushedAt: string;
  topics: string[];
}

interface ApiRepo {
  name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  fork: boolean;
  archived: boolean;
  private: boolean;
  pushed_at: string;
  topics?: string[];
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly rateLimited: boolean;
  constructor(message: string, status: number, rateLimited = false) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

const API = 'https://api.github.com';
const MAX_PAGES = 10;

const normalize = (r: ApiRepo): RepoData => ({
  name: r.name,
  url: r.html_url,
  description: r.description?.trim() || null,
  language: r.language,
  stars: r.stargazers_count,
  fork: r.fork,
  archived: r.archived,
  pushedAt: r.pushed_at,
  topics: r.topics ?? [],
});

const nextLink = (link: string | null): string | null =>
  link?.split(',').find((part) => part.includes('rel="next"'))?.match(/<([^>]+)>/)?.[1] ?? null;

/** Fetches all public repositories owned by `user`, following pagination. */
export async function fetchPublicRepos(
  user: string,
  { token, timeoutMs = 10_000 }: { token?: string; timeoutMs?: number } = {},
): Promise<RepoData[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${user}-website-build`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const repos: RepoData[] = [];
  let url: string | null =
    `${API}/users/${encodeURIComponent(user)}/repos?type=owner&sort=pushed&per_page=100`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res: Response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const rateLimited = res.status === 429 || (res.status === 403 && remaining === '0');
      const reset = res.headers.get('x-ratelimit-reset');
      const hint = rateLimited && reset ? ` (rate limit resets ${new Date(Number(reset) * 1000).toISOString()})` : '';
      throw new GitHubApiError(`GitHub API responded ${res.status} for ${url}${hint}`, res.status, rateLimited);
    }

    const data = (await res.json()) as ApiRepo[];
    repos.push(...data.filter((r) => !r.private).map(normalize));
    url = nextLink(res.headers.get('link'));
  }

  return repos;
}
