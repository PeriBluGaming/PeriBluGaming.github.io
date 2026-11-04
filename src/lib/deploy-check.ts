/**
 * Decides whether the scheduled workflow has to rebuild and redeploy the site, and verifies before deploying that
 * a build is still the newest one. Used by scripts/deploy-check.ts in .github/workflows/deploy.yml.
 *
 * The live site publishes /build-info.json (commit + content fingerprint of what it was built from). A rebuild is
 * needed when the code on main or the visible Sanity content differs from it. Failures never count as
 * "unchanged": an unreachable Sanity fails the check, an unreadable live build-info.json triggers a rebuild.
 *
 * Plain Node, no runtime dependencies (the check job runs without `npm ci`); network access is injected for tests.
 */
import { readBlogConfig } from './blog/config.ts';
import { computeFingerprint, fingerprintQuery, type ContentFingerprint } from './content-fingerprint.ts';

export const BUILD_INFO_PATH = '/build-info.json';
/** Bump when the build-info.json format changes; the next scheduled check then rebuilds once. */
export const BUILD_INFO_SCHEMA = 1;
export const PRODUCTION_BRANCH = 'main';
/** Frequent content check – builds only on changes. Must match .github/workflows/deploy.yml (tested). */
export const CHECK_CRON = '7,22,37,52 * * * *';
/** Daily forced build (03:17 UTC) – refreshes data that has no fingerprint (GitHub project cards). */
export const DAILY_REFRESH_CRON = '17 3 * * *';

export interface BuildInfo {
  schema: number;
  /** Git commit the site was built from (GITHUB_SHA); null for local builds. */
  commit: string | null;
  builtAt: string;
  /** Fingerprint of the Sanity content the build rendered; null if the blog was not built from Sanity. */
  content: ContentFingerprint | null;
}

export type LiveBuildInfo =
  | { state: 'found'; info: BuildInfo }
  | { state: 'missing' }
  | { state: 'unreadable'; reason: string };

export interface Decision {
  changed: boolean;
  reason: string;
}

type Fetch = typeof fetch;

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'none');
const isSha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);

export function createBuildInfo(commit: string | undefined, content: ContentFingerprint | null, now = new Date()): BuildInfo {
  return { schema: BUILD_INFO_SCHEMA, commit: isSha(commit) ? commit : null, builtAt: now.toISOString(), content };
}

export function parseBuildInfo(json: unknown): BuildInfo | null {
  if (typeof json !== 'object' || json === null) return null;
  const v = json as Record<string, unknown>;
  const c = v.content as Record<string, unknown> | null | undefined;
  const contentOk =
    c === null ||
    (typeof c === 'object' && typeof c.version === 'number' && typeof c.hash === 'string' && typeof c.count === 'number' && Array.isArray(c.types));
  if (typeof v.schema !== 'number' || !(v.commit === null || isSha(v.commit)) || typeof v.builtAt !== 'string' || !contentOk) return null;
  return v as unknown as BuildInfo;
}

/**
 * Runs that build regardless of the comparison: manual starts and the daily refresh. Returns the reason, or null for
 * the frequent content check. `schedule` is the cron expression that triggered the run (github.event.schedule).
 */
export function forceReason(eventName: string | undefined, schedule: string | undefined): string | null {
  if (eventName === 'workflow_dispatch') return 'manual run – always builds';
  if (eventName === 'schedule' && schedule === DAILY_REFRESH_CRON) {
    return 'daily refresh (GitHub project data) – always builds';
  }
  return null;
}

/** Compares the live site with the current state of main and Sanity. `force`: reason from forceReason(). */
export function decideDeploy(input: { current: ContentFingerprint; commit: string; live: LiveBuildInfo; force: string | null }): Decision {
  const { current, commit, live, force } = input;
  if (force) return { changed: true, reason: force };
  if (live.state === 'missing') return { changed: true, reason: 'no build-info.json on the live site yet (first publication)' };
  if (live.state === 'unreadable') return { changed: true, reason: `live build-info.json unreadable (${live.reason}) – rebuilding` };

  const { info } = live;
  if (info.schema !== BUILD_INFO_SCHEMA || !info.content || info.content.version !== current.version) {
    return { changed: true, reason: 'live build info has an older format or no content fingerprint' };
  }
  if (info.commit !== commit) return { changed: true, reason: `code changed (${short(info.commit)} → ${short(commit)})` };
  if (info.content.hash !== current.hash) {
    return { changed: true, reason: `content changed (${info.content.count} → ${current.count} visible documents)` };
  }
  return { changed: false, reason: 'no changes since the live build' };
}

/** Last gate before deploying: a build may only go live if nothing newer exists (main head and content). */
export function verifyDeploy(input: { built: { commit: string; hash: string }; mainHead: string; current: ContentFingerprint }): {
  deploy: boolean;
  reason: string;
} {
  const { built, mainHead, current } = input;
  if (built.commit !== mainHead) {
    return { deploy: false, reason: `superseded – ${PRODUCTION_BRANCH} moved on (built ${short(built.commit)}, now ${short(mainHead)})` };
  }
  if (built.hash !== current.hash) return { deploy: false, reason: 'superseded – Sanity content changed after this build' };
  return { deploy: true, reason: 'build is current' };
}

/** Current fingerprint from Sanity's public API: tokenless, published perspective only. Throws on any failure. */
export async function fetchContentFingerprint(
  env: Record<string, string | undefined>,
  { fetchImpl = fetch, attempts = 3, delayMs = 2_000 }: { fetchImpl?: Fetch; attempts?: number; delayMs?: number } = {},
): Promise<ContentFingerprint> {
  // Public dataset: never use a token here, even if one is present in the environment.
  const config = readBlogConfig({ SANITY_PROJECT_ID: env.SANITY_PROJECT_ID, SANITY_DATASET: env.SANITY_DATASET, SANITY_API_VERSION: env.SANITY_API_VERSION });
  if (config.mode !== 'sanity') {
    throw new Error('SANITY_PROJECT_ID is not set – define the repository variables SANITY_PROJECT_ID and SANITY_DATASET.');
  }

  const url = new URL(`https://${config.projectId}.api.sanity.io/v${config.apiVersion}/data/query/${config.dataset}`);
  url.searchParams.set('query', fingerprintQuery());
  url.searchParams.set('perspective', 'published');

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown };
      return computeFingerprint(body?.result);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  throw new Error(`Sanity query failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** The live site's build info. Bypasses the Pages CDN cache; never throws. */
export async function fetchLiveBuildInfo(siteUrl: string, { fetchImpl = fetch }: { fetchImpl?: Fetch } = {}): Promise<LiveBuildInfo> {
  const url = new URL(BUILD_INFO_PATH, siteUrl);
  url.searchParams.set('nocache', String(Date.now()));
  try {
    const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { state: 'missing' };
    if (!res.ok) return { state: 'unreadable', reason: `HTTP ${res.status}` };
    const info = parseBuildInfo(await res.json());
    return info ? { state: 'found', info } : { state: 'unreadable', reason: 'unexpected format' };
  } catch (err) {
    return { state: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
}
