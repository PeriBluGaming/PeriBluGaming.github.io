/**
 * READ-ONLY inputs for the project migration dry run (src/lib/project-migration.ts).
 *
 * - GitHub: public repository list without a token (live API, otherwise the fallback snapshot – with the limitation
 *   stated in the report).
 * - Sanity: published `project` documents and image assets matched by SHA-1, through `readOnlySanityFetch` only:
 *   GET to the query endpoint, never a token, never another host or path. Write and upload endpoints are unreachable,
 *   even if credentials are present in the environment.
 * - Local screenshots: existence and SHA-1 of the configured files.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBlogConfig } from './blog/config.ts';
import { fetchPublicRepos, type RepoData } from './github.ts';
import type { ExistingProjectDoc, LocalScreenshot } from './project-migration.ts';
import type { MergeConfig } from './project-merge.ts';
import { PROJECT_DOCUMENT_FILTER } from './project-visibility.ts';

export class MigrationAbort extends Error {
  constructor(message: string) {
    super(`[migration] ${message}`);
    this.name = 'MigrationAbort';
  }
}

/** Every published project document with the fields a migration compares (screenshots: alt + asset reference). */
export const EXISTING_PROJECTS_QUERY = /* groq */ `*[${PROJECT_DOCUMENT_FILTER}] | order(_id asc) {
  _id, repo, title, description, category, tags, hidden, featured, featuredOrder, accent,
  "screenshots": screenshots[]{ alt, "assetRef": asset._ref }
}`;

/** Image assets with the given SHA-1 hashes (identical files already uploaded). */
export const ASSETS_BY_SHA1_QUERY = /* groq */ `*[_type == "sanity.imageAsset" && sha1hash in $hashes] | order(_id asc) { _id, sha1hash }`;

const SANITY_QUERY_HOST = /^[a-z0-9]+\.api\.sanity\.io$/;
const SANITY_QUERY_PATH = /^\/v\d{4}-\d{2}-\d{2}\/data\/query\/[a-z0-9][a-z0-9_-]*$/;

/**
 * The only way this module talks to Sanity: GET on the public query endpoint, no credentials, no cookies.
 * Throws for any other host or path (mutate, assets, projects API …) before a request is made.
 */
export function readOnlySanityFetch(fetchImpl: typeof fetch = fetch) {
  return async (url: URL): Promise<unknown> => {
    if (url.protocol !== 'https:' || !SANITY_QUERY_HOST.test(url.host) || !SANITY_QUERY_PATH.test(url.pathname)) {
      throw new MigrationAbort(`refusing non-query Sanity request: ${url.host}${url.pathname}`);
    }
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'periblugaming-project-migration-dry-run' },
      credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new MigrationAbort(`Sanity query failed: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown };
    return body?.result;
  };
}

/** Local screenshots of the featured configuration: existence and SHA-1 (Sanity asset lookup is done separately). */
export function localScreenshots(config: MergeConfig, root: string): LocalScreenshot[] {
  return config.featuredProjects.flatMap((f) => {
    if (!f.image) return [];
    const file = join(root, 'public', f.image.src);
    const exists = existsSync(file) && statSync(file).isFile();
    return [{
      repo: f.repo,
      path: f.image.src,
      exists,
      alt: f.image.alt,
      position: f.image.position ?? 'center',
      sha1: exists ? createHash('sha1').update(readFileSync(file)).digest('hex') : null,
      sanityAssetId: null,
    }];
  });
}

export interface MigrationInputs {
  repos: RepoData[];
  githubSource: string;
  existing: ExistingProjectDoc[];
  sanitySource: string;
  screenshots: LocalScreenshot[];
}

export async function collectInputs(options: {
  env: Record<string, string | undefined>;
  root: string;
  config: MergeConfig;
  githubUser: string;
  fallback: { fetchedAt: string; repos: RepoData[] };
  fetchImpl?: typeof fetch;
  fetchRepos?: typeof fetchPublicRepos;
}): Promise<MigrationInputs> {
  const { env, root, config, githubUser, fallback } = options;
  const sanityGet = readOnlySanityFetch(options.fetchImpl);

  // GitHub – public data only, never with a token.
  let repos: RepoData[];
  let githubSource: string;
  const useFallback = (reason: string) => {
    repos = fallback.repos;
    githubSource =
      `FALLBACK snapshot from ${fallback.fetchedAt} (${reason}). Limitation: repositories created or changed after the ` +
      'snapshot are missing or outdated – their proposals are SKIPPED. Re-run with GitHub available.';
  };
  if (env.GITHUB_OFFLINE === '1') useFallback('GITHUB_OFFLINE=1');
  else {
    try {
      repos = await (options.fetchRepos ?? fetchPublicRepos)(githubUser, {});
      githubSource = `live GitHub API (${repos.length} public repositories of ${githubUser})`;
    } catch (err) {
      useFallback(`GitHub API unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sanity – published documents only, tokenless.
  let sanity;
  try {
    sanity = readBlogConfig({ SANITY_PROJECT_ID: env.SANITY_PROJECT_ID, SANITY_DATASET: env.SANITY_DATASET, SANITY_API_VERSION: env.SANITY_API_VERSION });
  } catch (err) {
    throw new MigrationAbort(err instanceof Error ? err.message : String(err));
  }
  if (sanity.mode !== 'sanity') {
    throw new MigrationAbort('SANITY_PROJECT_ID is not set – existing documents cannot be read, so CREATE and UPDATE cannot be told apart.');
  }
  const queryUrl = (query: string, params: Record<string, unknown> = {}) => {
    const url = new URL(`https://${sanity.projectId}.api.sanity.io/v${sanity.apiVersion}/data/query/${sanity.dataset}`);
    url.searchParams.set('query', query);
    url.searchParams.set('perspective', 'published');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`$${k}`, JSON.stringify(v));
    return url;
  };

  let existing: unknown;
  try {
    existing = await sanityGet(queryUrl(EXISTING_PROJECTS_QUERY));
  } catch (err) {
    throw new MigrationAbort(`could not read existing project documents – no plan without them (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!Array.isArray(existing)) throw new MigrationAbort('unexpected response for existing project documents – no plan.');

  const screenshots = localScreenshots(config, root);
  const hashes = screenshots.map((s) => s.sha1).filter((h): h is string => h !== null);
  if (hashes.length) {
    let assets: unknown;
    try {
      assets = await sanityGet(queryUrl(ASSETS_BY_SHA1_QUERY, { hashes }));
    } catch (err) {
      throw new MigrationAbort(`could not look up existing image assets (${err instanceof Error ? err.message : String(err)}).`);
    }
    const bySha = new Map((Array.isArray(assets) ? assets : []).map((a: { _id: string; sha1hash: string }) => [a.sha1hash, a._id]));
    for (const s of screenshots) s.sanityAssetId = (s.sha1 && bySha.get(s.sha1)) || null;
  }

  // GROQ cannot tell an explicitly stored null from a missing field, so the tokenless dry run treats null as missing.
  // The authenticated preflight reads the exact stored documents instead (explicit null → conflict, never written).
  const withoutNulls = (existing as Record<string, unknown>[]).map((d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null)));

  return {
    repos: repos!,
    githubSource: githubSource!,
    existing: withoutNulls as unknown as ExistingProjectDoc[],
    sanitySource: `published documents of ${sanity.projectId}/${sanity.dataset} (read without a token): ${existing.length} project document(s)`,
    screenshots,
  };
}

/**
 * Validates proposed documents with the real Studio schema and Sanity's validation engine – offline: the duplicate
 * check sees the existing plus all proposed documents. Returns errors per document ID, or null if the Studio
 * dependencies aren't installed.
 */
export async function validateWithStudioSchema(
  root: string,
  docs: { _id: string; _type: string; repo: string }[],
  existing: ExistingProjectDoc[],
): Promise<Map<string, string[]> | null> {
  const studio = pathToFileURL(join(root, 'studio/'));
  if (!existsSync(new URL('node_modules/sanity/package.json', studio))) return null;
  const sanity = await import(pathToFileURL(createRequire(new URL('package.json', studio)).resolve('sanity')).href);
  const { schemaTypes } = await import(new URL('schemaTypes/index.ts', studio).href);
  const schema = sanity.createSchema({ name: 'default', types: schemaTypes });
  const known = [...existing.map((d) => ({ _id: d._id, repo: d.repo })), ...docs.map((d) => ({ _id: d._id, repo: d.repo }))];
  const client = {
    fetch: async () => known,
    withConfig() {
      return client;
    },
    getDataUrl: () => '',
    request: async () => ({}),
    observable: { fetch: () => { throw new Error('not used'); } },
  };
  const i18n = { t: (key: string) => key, loadNamespaces: async () => {}, locales: [], loadedLocales: {} };
  const errors = new Map<string, string[]>();
  for (const doc of docs) {
    const markers: { level: string; path: unknown[]; message?: string; item?: { message?: string } }[] = await sanity.validateDocument({
      document: doc,
      workspace: { schema, getClient: () => client, i18n },
      getDocumentExists: async () => true,
      environment: 'cli',
    });
    errors.set(doc._id, markers.filter((m) => m.level === 'error').map((m) => `${m.path.join('.') || '(document)'}: ${m.message ?? m.item?.message}`));
  }
  return errors;
}
