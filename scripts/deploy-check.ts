/**
 * Deploy gate for .github/workflows/deploy.yml (see docs/deployment.md).
 *
 *   node scripts/deploy-check.ts check    → outputs changed=true|false, reason (EVENT_NAME, EVENT_SCHEDULE)
 *   node scripts/deploy-check.ts built    → validates dist/build-info.json, outputs commit + content_hash
 *   node scripts/deploy-check.ts verify   → outputs deploy=true|false, reason (BUILT_COMMIT, BUILT_CONTENT_HASH)
 *
 * Optional SITE_URL (local testing only) points the check at another copy of the site, e.g. `npm run preview`.
 * Reads Sanity without a token. Exits non-zero on errors – a failed check never means "no changes".
 * Runs on plain Node (type stripping), no `npm ci` required.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { site } from '../src/config/site.ts';
import {
  PRODUCTION_BRANCH,
  decideDeploy,
  fetchContentFingerprint,
  fetchLiveBuildInfo,
  forceReason,
  parseBuildInfo,
  verifyDeploy,
} from '../src/lib/deploy-check.ts';

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

async function check(): Promise<void> {
  const commit = requireSha('GITHUB_SHA', env.GITHUB_SHA);
  const current = await fetchContentFingerprint(env);
  // SITE_URL only for local testing against `npm run preview`; the workflow checks the real site.
  const live = await fetchLiveBuildInfo(env.SITE_URL || site.url);
  const force = forceReason(env.EVENT_NAME, env.EVENT_SCHEDULE);
  const decision = decideDeploy({ current, commit, live, force });
  output(
    { changed: String(decision.changed), reason: decision.reason },
    `**Deploy check:** ${decision.changed ? 'rebuild' : 'skip'} – ${decision.reason} (${current.count} visible documents)`,
  );
}

function built(): void {
  const info = parseBuildInfo(JSON.parse(readFileSync(new URL('../dist/build-info.json', import.meta.url), 'utf8')));
  if (!info) throw new Error('dist/build-info.json is missing or malformed.');
  const commit = requireSha('build-info commit', info.commit ?? undefined);
  if (!info.content) {
    // Without a fingerprint every scheduled check would rebuild again – refuse instead of looping.
    throw new Error('The build has no content fingerprint – the blog was not built from Sanity (check SANITY_PROJECT_ID).');
  }
  output({ commit, content_hash: info.content.hash }, `**Build:** ${commit.slice(0, 7)}, ${info.content.count} visible documents`);
}

async function verify(): Promise<void> {
  const builtCommit = requireSha('BUILT_COMMIT', env.BUILT_COMMIT);
  const hash = env.BUILT_CONTENT_HASH ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('BUILT_CONTENT_HASH is missing or invalid.');
  const result = verifyDeploy({ built: { commit: builtCommit, hash }, mainHead: mainHead(), current: await fetchContentFingerprint(env) });
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
