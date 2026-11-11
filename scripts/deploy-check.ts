/**
 * Deploy gate for .github/workflows/deploy.yml (see docs/deployment.md).
 *
 *   node scripts/deploy-check.ts check    → outputs changed=true|false, reason (EVENT_NAME, EVENT_SCHEDULE, GITHUB_TOKEN)
 *                                           code, Sanity content and – every 15 minutes – the projects' GitHub releases
 *   node scripts/deploy-check.ts built    → validates dist/build-info.json and the page guard (dist/projects/pages.json
 *                                           vs. the live manifest), outputs commit + content_hash + manifest
 *   node scripts/deploy-check.ts verify   → outputs deploy=true|false, reason (BUILT_COMMIT, BUILT_CONTENT_HASH,
 *                                           BUILT_MANIFEST); repeats the page guard against the live site
 *
 * Optional SITE_URL (local testing only) points the check at another copy of the site, e.g. `npm run preview`.
 * Reads Sanity without a token. Exits non-zero on errors – a failed check never means "no changes".
 * Runs on plain Node (type stripping), no `npm ci` required.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { retiredDetailPages } from '../src/config/projects.ts';
import { site } from '../src/config/site.ts';
import {
  PRODUCTION_BRANCH,
  decideDeploy,
  decideWithReleases,
  fetchContentFingerprint,
  fetchCurrentReleases,
  fetchLiveBuildInfo,
  forceReason,
  guardPages,
  parseBuildInfo,
  verifyDeploy,
} from '../src/lib/deploy-check.ts';
import { MANIFEST_SCHEMA, fetchLiveManifest } from '../src/lib/page-manifest.ts';

const env = process.env;

function output(values: Record<string, string>, summary: string): void {
  for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

function requireSha(name: string, value: string | undefined): string {
  if (!value || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a full commit SHA (got "${value ?? ''}").`);
  return value;
}

function mainHead(): string {
  // Public repository: read the current head of main without credentials.
  const repo = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY ?? 'PeriBluGaming/PeriBluGaming.github.io'}.git`;
  const out = execFileSync('git', ['ls-remote', repo, `refs/heads/${PRODUCTION_BRANCH}`], { encoding: 'utf8', timeout: 30_000 });
  return requireSha(`head of ${PRODUCTION_BRANCH}`, out.split(/\s/)[0]);
}

// SITE_URL only for local testing against `npm run preview`; the workflow checks the real site.
const siteUrl = () => env.SITE_URL || site.url;

async function check(): Promise<void> {
  const commit = requireSha('GITHUB_SHA', env.GITHUB_SHA);
  const current = await fetchContentFingerprint(env);
  const live = await fetchLiveBuildInfo(siteUrl());
  const force = forceReason(env.EVENT_NAME, env.EVENT_SCHEDULE);
  const decision = await decideWithReleases({
    base: decideDeploy({ current, commit, live, force }),
    liveInfo: live,
    loadManifest: () => fetchLiveManifest(siteUrl()),
    loadReleases: (pages) => fetchCurrentReleases(site.githubUser, pages, { token: env.GITHUB_TOKEN || undefined }),
  });
  output(
    { changed: String(decision.changed), reason: decision.reason },
    `**Deploy check:** ${decision.changed ? 'rebuild' : 'skip'} – ${decision.reason} (${current.count} visible documents)`,
  );
}

function readDistJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(new URL(`../dist/${path}`, import.meta.url), 'utf8'));
  } catch (err) {
    throw new Error(`dist/${path} is missing or not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/** Page guard against the live site; throws with one annotation per problem when the build may not go live. */
async function pageGuard(next: unknown): Promise<string> {
  const [liveInfo, liveManifest] = await Promise.all([fetchLiveBuildInfo(siteUrl()), fetchLiveManifest(siteUrl())]);
  const result = guardPages({ next, liveInfo, liveManifest, retired: retiredDetailPages });
  if (!result.deploy) {
    for (const problem of result.problems) console.error(`::error::Page guard: ${problem}`);
    throw new Error(`Page guard refused the deployment – ${result.reason}. Recovery: docs/project-pages.md → "When the page guard blocks a deployment".`);
  }
  return result.reason;
}

async function built(): Promise<void> {
  const info = parseBuildInfo(readDistJson('build-info.json'));
  if (!info) throw new Error('dist/build-info.json is missing or malformed.');
  if (info.manifest !== MANIFEST_SCHEMA) throw new Error('dist/build-info.json does not declare the page manifest – not deploying.');
  const commit = requireSha('build-info commit', info.commit ?? undefined);
  if (!info.content) {
    // Without a fingerprint every scheduled check would rebuild again – refuse instead of looping.
    throw new Error(
      'The build has no content fingerprint – posts or projects were not loaded from Sanity (see the "[build-info]" ' +
        'line in the build log; check SANITY_PROJECT_ID and Sanity availability). Not deploying.',
    );
  }
  const manifest = readDistJson('projects/pages.json');
  const pages = await pageGuard(manifest);
  output(
    { commit, content_hash: info.content.hash, manifest: Buffer.from(JSON.stringify(manifest)).toString('base64') },
    `**Build:** ${commit.slice(0, 7)}, ${info.content.count} visible documents\n\n**Page guard:** ${pages}`,
  );
}

async function verify(): Promise<void> {
  const builtCommit = requireSha('BUILT_COMMIT', env.BUILT_COMMIT);
  const hash = env.BUILT_CONTENT_HASH ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('BUILT_CONTENT_HASH is missing or invalid.');
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(env.BUILT_MANIFEST ?? '', 'base64').toString('utf8'));
  } catch {
    throw new Error('BUILT_MANIFEST is missing or invalid.');
  }
  const result = verifyDeploy({ built: { commit: builtCommit, hash }, mainHead: mainHead(), current: await fetchContentFingerprint(env) });
  // Repeated here because this job can be re-run on its own, after the live site changed.
  if (result.deploy) result.reason = `${result.reason}; page guard: ${await pageGuard(manifest)}`;
  output({ deploy: String(result.deploy), reason: result.reason }, `**Deploy gate:** ${result.deploy ? 'deploy' : 'skip'} – ${result.reason}`);
}

const commands: Record<string, () => void | Promise<void>> = { check, built, verify };
const command = commands[process.argv[2] ?? ''];
if (!command) {
  console.error('Usage: node scripts/deploy-check.ts <check|built|verify>');
  process.exit(2);
}
try {
  await command();
} catch (err) {
  console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
