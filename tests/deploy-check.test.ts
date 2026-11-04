/**
 * Deploy gate: rebuild only when needed, never treat a failure as "unchanged", never deploy an outdated build.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeFingerprint } from '../src/lib/content-fingerprint.ts';
import { readFileSync } from 'node:fs';
import {
  BUILD_INFO_SCHEMA,
  CHECK_CRON,
  DAILY_REFRESH_CRON,
  createBuildInfo,
  decideDeploy,
  fetchContentFingerprint,
  fetchLiveBuildInfo,
  forceReason,
  parseBuildInfo,
  verifyDeploy,
  type LiveBuildInfo,
} from '../src/lib/deploy-check.ts';

const sha1 = 'a'.repeat(40);
const sha2 = 'b'.repeat(40);
const current = computeFingerprint([{ _type: 'post', _id: 'p1', _rev: 'r1' }]);
const other = computeFingerprint([{ _type: 'post', _id: 'p1', _rev: 'r2' }]);
const live = (commit: string, content = current): LiveBuildInfo => ({ state: 'found', info: createBuildInfo(commit, content) });
const env = { SANITY_PROJECT_ID: 'hyyn359x', SANITY_DATASET: 'production' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('decideDeploy', () => {
  const decide = (l: LiveBuildInfo, force: string | null = null, commit = sha1) => decideDeploy({ current, commit, live: l, force });

  it('skips when code and content are unchanged', () => {
    assert.equal(decide(live(sha1)).changed, false);
  });

  it('rebuilds when content or code changed', () => {
    assert.match(decide(live(sha1, other)).reason, /content changed/);
    assert.match(decide(live(sha2)).reason, /code changed \(bbbbbbb → aaaaaaa\)/);
  });

  it('supports the first publication without build-info.json', () => {
    assert.deepEqual(decide({ state: 'missing' }), { changed: true, reason: 'no build-info.json on the live site yet (first publication)' });
  });

  it('rebuilds (never skips) when the live build info is unreadable, outdated or has no fingerprint', () => {
    assert.equal(decide({ state: 'unreadable', reason: 'HTTP 503' }).changed, true);
    assert.equal(decide({ state: 'found', info: { ...createBuildInfo(sha1, current), schema: BUILD_INFO_SCHEMA + 1 } }).changed, true);
    assert.equal(decide(live(sha1, { ...current, version: current.version + 1 })).changed, true);
    assert.equal(decide({ state: 'found', info: createBuildInfo(sha1, null) }).changed, true);
  });

  it('always rebuilds on a manual run and on the daily refresh, even without any change', () => {
    for (const force of [forceReason('workflow_dispatch', undefined), forceReason('schedule', DAILY_REFRESH_CRON)]) {
      const d = decide(live(sha1), force);
      assert.equal(d.changed, true);
      assert.equal(d.reason, force);
    }
  });
});

describe('forceReason', () => {
  it('forces manual runs and the daily refresh only', () => {
    assert.match(forceReason('workflow_dispatch', undefined)!, /manual run/);
    assert.match(forceReason('schedule', DAILY_REFRESH_CRON)!, /daily refresh/);
    assert.equal(forceReason('schedule', CHECK_CRON), null); // 15-minute check: only on changes
    assert.equal(forceReason('schedule', undefined), null);
    assert.equal(forceReason('push', DAILY_REFRESH_CRON), null);
    assert.equal(forceReason(undefined, undefined), null);
  });
});

describe('scheduled posts', () => {
  it('a post becoming visible changes the fingerprint without a new revision', () => {
    // Same document, same _rev – it only enters the visible set once publishedAt <= now() (server-side filter).
    const before = computeFingerprint([]);
    const after = computeFingerprint([{ _type: 'post', _id: 'scheduled', _rev: 'unchanged' }]);
    assert.equal(decideDeploy({ current: after, commit: sha1, live: live(sha1, before), force: null }).changed, true);
  });
});

describe('deploy.yml', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

  it('schedules exactly the content check and the daily refresh, on different minutes', () => {
    const crons = [...workflow.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(crons, [CHECK_CRON, DAILY_REFRESH_CRON]);
    const checkMinutes = CHECK_CRON.split(' ')[0].split(',');
    assert.ok(!checkMinutes.includes(DAILY_REFRESH_CRON.split(' ')[0]));
  });

  it('passes the trigger to the check and keeps manual runs', () => {
    assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
    assert.match(workflow, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
    assert.match(workflow, /EVENT_SCHEDULE: \$\{\{ github\.event\.schedule \}\}/);
  });

  it('deploys only from main, with least privilege and the gate inside the deploy job', () => {
    assert.match(workflow, /^permissions: \{\}$/m);
    assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
    assert.match(workflow, /group: pages\n\s+cancel-in-progress: false/);
    const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));
    assert.match(deployJob, /deploy-check\.ts verify/);
    assert.match(deployJob, /if: steps\.gate\.outputs\.deploy == 'true'\n\s+uses: actions\/deploy-pages/);
    assert.equal((workflow.match(/pages: write/g) ?? []).length, 1);
    assert.doesNotMatch(workflow, /SANITY_READ_TOKEN|secrets\.(?!GITHUB_TOKEN)/);
  });
});

describe('verifyDeploy', () => {
  it('deploys only the newest build', () => {
    assert.equal(verifyDeploy({ built: { commit: sha1, hash: current.hash }, mainHead: sha1, current }).deploy, true);
    assert.match(verifyDeploy({ built: { commit: sha1, hash: current.hash }, mainHead: sha2, current }).reason, /main moved on/);
    assert.match(verifyDeploy({ built: { commit: sha1, hash: current.hash }, mainHead: sha1, current: other }).reason, /content changed/);
  });
});

describe('build info', () => {
  it('round-trips and rejects malformed data', () => {
    const info = createBuildInfo(sha1, current, new Date('2026-11-04T10:00:00Z'));
    assert.deepEqual(parseBuildInfo(JSON.parse(JSON.stringify(info))), info);
    assert.equal(createBuildInfo(undefined, null).commit, null);
    assert.equal(parseBuildInfo({ ...info, commit: 'main' }), null);
    assert.equal(parseBuildInfo({ ...info, content: { hash: 'x' } }), null);
    assert.equal(parseBuildInfo('nope'), null);
  });
});

describe('fetchContentFingerprint', () => {
  it('queries the public API tokenless with the published perspective', async () => {
    let requested: URL | undefined;
    let headers: HeadersInit | undefined;
    const fp = await fetchContentFingerprint(
      { ...env, SANITY_READ_TOKEN: 'sk-secret' },
      {
        fetchImpl: async (url, init) => {
          requested = new URL(String(url));
          headers = init?.headers;
          return json(200, { result: [{ _type: 'post', _id: 'p1', _rev: 'r1' }] });
        },
      },
    );
    assert.equal(fp.hash, current.hash);
    assert.equal(requested?.host, 'hyyn359x.api.sanity.io');
    assert.equal(requested?.searchParams.get('perspective'), 'published');
    assert.doesNotMatch(JSON.stringify(headers), /sk-secret|Authorization/i);
  });

  it('fails (never reports "no changes") when Sanity is not configured or unreachable', async () => {
    await assert.rejects(fetchContentFingerprint({}), /SANITY_PROJECT_ID is not set/);
    let calls = 0;
    const failing = async () => {
      calls++;
      return json(503, {});
    };
    await assert.rejects(fetchContentFingerprint(env, { fetchImpl: failing, delayMs: 0 }), /after 3 attempts: HTTP 503/);
    assert.equal(calls, 3);
    await assert.rejects(fetchContentFingerprint(env, { fetchImpl: async () => json(200, { error: 'x' }), attempts: 1 }), /expected an array/);
  });
});

describe('fetchLiveBuildInfo', () => {
  const site = 'https://periblugaming.github.io';

  it('bypasses the CDN cache and parses the build info', async () => {
    let requested: URL | undefined;
    const info = createBuildInfo(sha1, current);
    const result = await fetchLiveBuildInfo(site, {
      fetchImpl: async (url) => {
        requested = new URL(String(url));
        return json(200, info);
      },
    });
    assert.equal(requested?.pathname, '/build-info.json');
    assert.ok(requested?.searchParams.has('nocache'));
    assert.deepEqual(result, { state: 'found', info });
  });

  it('distinguishes a missing file from an unreadable one', async () => {
    assert.deepEqual(await fetchLiveBuildInfo(site, { fetchImpl: async () => json(404, {}) }), { state: 'missing' });
    assert.equal((await fetchLiveBuildInfo(site, { fetchImpl: async () => json(500, {}) })).state, 'unreadable');
    assert.equal((await fetchLiveBuildInfo(site, { fetchImpl: async () => new Response('<html>') })).state, 'unreadable');
    assert.equal(
      (await fetchLiveBuildInfo(site, { fetchImpl: async () => { throw new Error('ECONNRESET'); } })).state,
      'unreadable',
    );
  });
});
