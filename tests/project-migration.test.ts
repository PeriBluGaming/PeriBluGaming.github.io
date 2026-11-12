/**
 * Sanity project migration DRY RUN (src/lib/project-migration*.ts, scripts/sanity-project-migration-dry-run.ts).
 * Uses the real configuration, screenshots, website merge/validation and – if installed – the Studio schema.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as projectConfig from '../src/config/projects.ts';
import type { RepoData } from '../src/lib/github.ts';
import { validateProjectImage } from '../src/lib/project-image.ts';
import type { MergeConfig } from '../src/lib/project-merge.ts';
import {
  MIGRATION_ADDITIONS,
  documentIdForRepo,
  planMigration,
  proposedDocuments,
  renderReport,
  type ExistingProjectDoc,
  type LocalScreenshot,
  type PlanInput,
} from '../src/lib/project-migration.ts';
import { MigrationAbort, collectInputs, readOnlySanityFetch, validateWithStudioSchema } from '../src/lib/project-migration-io.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const { categories, defaultCategory, featuredProjects, listSettings, projectOverrides } = projectConfig;
const config: MergeConfig = { categories, defaultCategory, projectOverrides, featuredProjects, listSettings };
const fallback = JSON.parse(readFileSync(join(root, 'tests/fixtures/fallback-repos-2026-11-02.json'), 'utf8')) as { fetchedAt: string; repos: RepoData[] };
const resolveLocalImage = (image: Parameters<typeof validateProjectImage>[0], repo: string) => validateProjectImage(image, repo, join(root, 'public'));
const studioReady = existsSync(join(root, 'studio/node_modules/sanity/package.json'));

const repo = (name: string, extra: Partial<RepoData> = {}): RepoData => ({
  name, url: `https://github.com/PeriBluGaming/${name}`, description: `${name} on GitHub`, language: 'C', stars: 0,
  fork: false, archived: false, pushedAt: '2026-11-03T16:10:16Z', topics: [], ...extra,
});
/** Current public inventory: the snapshot plus the two repositories published since. */
// Frozen snapshot (as of 2026-11-02, without SledStorm): the migration plan was reviewed against this inventory.
const inventory: RepoData[] = [...fallback.repos, repo('SledStormPSXRecomp'), repo('PeriBluGaming.github.io', { language: 'Astro' })];
const CURRENT_FEATURED = ['ToyStory2Recomp', 'BugsBunnyLostinTimeRecomp', 'RescueShotRecomp', 'SuperMarioWorld2YoshisIslandRecomp', 'romm2switch'];

const sha1 = (path: string) => createHash('sha1').update(readFileSync(join(root, 'public', path))).digest('hex');
const screenshots: LocalScreenshot[] = featuredProjects.flatMap((f) =>
  f.image ? [{ repo: f.repo, path: f.image.src, exists: true, alt: f.image.alt, position: f.image.position ?? 'center', sha1: sha1(f.image.src), sanityAssetId: null }] : [],
);
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  config, repos: inventory, githubSource: 'live (test)', existing: [], sanitySource: 'test', screenshots, resolveLocalImage, ...over,
});
const byRepo = (plan: ReturnType<typeof planMigration>, name: string) => plan.projects.find((p) => p.repo === name)!;

/** Sanity query endpoint stub: answers project and asset queries, records every request. */
function sanityStub(projects: unknown, assets: unknown = [], status = 200) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    requests.push({ url, init });
    const query = url.searchParams.get('query') ?? '';
    const result = query.includes('sanity.imageAsset') ? assets : projects;
    return new Response(JSON.stringify(status === 200 ? { result } : { error: 'x' }), { status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}
const env = { SANITY_PROJECT_ID: 'hyyn359x', SANITY_DATASET: 'production' };

describe('document IDs', () => {
  it('are deterministic, lowercase and case-insensitive per repository', () => {
    assert.equal(documentIdForRepo('ToyStory2Recomp'), 'project-toystory2recomp');
    assert.equal(documentIdForRepo(' toystory2recomp '), 'project-toystory2recomp');
    assert.equal(documentIdForRepo('PeriBluGaming.github.io'), 'project-periblugaming-github-io');
    assert.equal(documentIdForRepo('recomp-ui'), 'project-recomp-ui');
  });

  it('blocks proposals whose IDs would collide', () => {
    const plan = planMigration(input({
      repos: [...inventory, repo('a.b'), repo('a-b')],
      config: { ...config, projectOverrides: { ...projectOverrides, 'a.b': { title: 'A dot' }, 'a-b': { title: 'A dash' } } },
    }));
    assert.equal(byRepo(plan, 'a.b').operation, 'BLOCKED');
    assert.equal(byRepo(plan, 'a-b').operation, 'BLOCKED');
    assert.match(byRepo(plan, 'a.b').reasons.join(' '), /project-a-b would be shared/);
  });
});

describe('dry run against the current state (no Sanity documents)', () => {
  const plan = planMigration(input());

  it('proposes CREATE for the 7 configured projects plus the SledStorm addition', () => {
    assert.deepEqual(plan.summary.operations, { CREATE: 8, UPDATE: 0, UNCHANGED: 0, SKIP: 0, BLOCKED: 0 });
    assert.equal(plan.summary.configuredProjects, 7);
    assert.equal(plan.summary.existingSanityDocuments, 0);
    assert.deepEqual(plan.projects.map((p) => p.documentId), [
      'project-toystory2recomp', 'project-bugsbunnylostintimerecomp', 'project-rescueshotrecomp', 'project-sledstormpsxrecomp',
      'project-supermarioworld2yoshisislandrecomp', 'project-romm2switch', 'project-psxrecomp', 'project-recomp-ui',
    ]);
  });

  it('features SledStorm 4th as in the stash; the five keep their relative order (real merge)', () => {
    assert.deepEqual(plan.compatibility.currentFeatured, CURRENT_FEATURED);
    assert.deepEqual(plan.compatibility.proposedFeatured, [
      'ToyStory2Recomp', 'BugsBunnyLostinTimeRecomp', 'RescueShotRecomp', 'SledStormPSXRecomp', 'SuperMarioWorld2YoshisIslandRecomp', 'romm2switch',
    ]);
    const orders = Object.fromEntries(plan.projects.filter((p) => p.fields.featured).map((p) => [p.repo, p.fields.featuredOrder]));
    assert.deepEqual(orders, {
      ToyStory2Recomp: 0, BugsBunnyLostinTimeRecomp: 1, RescueShotRecomp: 2, SledStormPSXRecomp: 3, SuperMarioWorld2YoshisIslandRecomp: 4, romm2switch: 5,
    });
    assert.equal(new Set(Object.values(orders)).size, 6); // unique – no ties
  });

  it('the only position changes are the insertion and the two projects after it', () => {
    assert.deepEqual(plan.compatibility.positionChanges, [
      { name: 'SuperMarioWorld2YoshisIslandRecomp', current: 3, proposed: 4, intended: true },
      { name: 'romm2switch', current: 4, proposed: 5, intended: true },
      { name: 'SledStormPSXRecomp', current: null, proposed: 3, intended: true },
    ]);
    assert.match(renderReport(plan), /\| SledStormPSXRecomp \| – \| 4 \| yes \|/);
  });

  it('never reorders an existing document with a different featured order – it is blocked instead', () => {
    const p = planMigration(input({ existing: [{ _id: 'project-toystory2recomp', repo: 'ToyStory2Recomp', featured: true, featuredOrder: 9 }] }));
    assert.equal(byRepo(p, 'ToyStory2Recomp').operation, 'BLOCKED');
    assert.equal(byRepo(p, 'ToyStory2Recomp').fields.featuredOrder, 9); // kept
    // Existing projects keep their relative order; shifts only come from inserting SledStorm.
    const { currentFeatured, proposedFeatured } = p.compatibility;
    assert.deepEqual(proposedFeatured.filter((n) => n !== 'SledStormPSXRecomp'), currentFeatured);
    assert.ok(p.compatibility.positionChanges.every((c) => c.intended));
  });

  it('changes nothing on existing cards; every difference is the intended SledStorm addition', () => {
    assert.ok(plan.compatibility.differences.length > 0);
    assert.ok(plan.compatibility.differences.every((d) => d.name === 'SledStormPSXRecomp' && d.intended));
    assert.deepEqual([plan.compatibility.added, plan.compatibility.removed], [[], []]);
  });

  it('migrates SledStorm with exactly the values from the stash', () => {
    const sled = byRepo(plan, 'SledStormPSXRecomp');
    assert.equal(sled.origin, 'addition');
    assert.deepEqual(sled.fields, {
      repo: 'SledStormPSXRecomp', title: 'Sled Storm PSX Recomp',
      description: 'Native recompilation of Sled Storm for the PlayStation into a modern PC executable.',
      category: 'playstation', tags: ['PS1', 'Recomp'], hidden: false, featured: true, featuredOrder: 3, accent: 'cyan',
    });
    assert.equal(sled.screenshot.kind, 'none');
    assert.equal(MIGRATION_ADDITIONS.length, 1); // no other featured additions
  });

  it('copies the local editorial values unchanged and leaves non-featured projects without featured fields', () => {
    const ts2 = byRepo(plan, 'ToyStory2Recomp');
    const local = projectOverrides.ToyStory2Recomp;
    assert.deepEqual([ts2.fields.title, ts2.fields.description, ts2.fields.category, ts2.fields.tags, ts2.fields.accent], [local.title, local.description, local.category, local.tags, 'cyan']);
    const psx = byRepo(plan, 'psxrecomp');
    assert.deepEqual(['featured', 'featuredOrder', 'accent'].map((f) => f in psx.fields), [false, false, false]);
  });

  it('marks every local screenshot as pending upload with the local fallback intact; never writes image references', () => {
    for (const name of CURRENT_FEATURED) {
      const st = byRepo(plan, name).screenshot;
      assert.equal(st.kind, 'upload-required', name);
      assert.match(st.note, /Local fallback stays effective/);
    }
    assert.equal(plan.summary.screenshotUploads, 5);
    assert.ok(proposedDocuments(plan).every((d) => !('screenshots' in d)));
  });

  it('is repeatable and independent of input order', () => {
    const again = planMigration(input({ repos: [...inventory].reverse(), screenshots: [...screenshots].reverse() }));
    assert.deepEqual(again, plan);
    assert.equal(renderReport(again), renderReport(plan));
  });

  it('does not modify the configuration', () => {
    const before = structuredClone(config);
    const file = readFileSync(join(root, 'src/config/projects.ts'), 'utf8');
    planMigration(input());
    assert.deepEqual(config, before);
    assert.equal(readFileSync(join(root, 'src/config/projects.ts'), 'utf8'), file);
  });
});

describe('existing Sanity documents', () => {
  const ts2 = (fields: Partial<ExistingProjectDoc> = {}): ExistingProjectDoc => ({
    _id: 'project-toystory2recomp', repo: 'ToyStory2Recomp', title: 'Toy Story 2 Recomp',
    description: 'Native recompilation with modern camera, widescreen and more.', category: 'playstation', tags: ['PS1', 'Recomp'],
    hidden: false, featured: true, featuredOrder: 0, accent: 'cyan', ...fields,
  });

  it('identical → UNCHANGED; missing fields → UPDATE that only adds them', () => {
    assert.equal(byRepo(planMigration(input({ existing: [ts2()] })), 'ToyStory2Recomp').operation, 'UNCHANGED');
    const partial = byRepo(planMigration(input({ existing: [ts2({ tags: undefined, accent: undefined })] })), 'ToyStory2Recomp');
    assert.equal(partial.operation, 'UPDATE');
    assert.match(partial.reasons[0], /Adds missing fields only: tags, accent/);
  });

  it('keeps an existing document ID instead of creating a duplicate', () => {
    const p = byRepo(planMigration(input({ existing: [ts2({ _id: 'b9f1c2d3-legacy', repo: 'toystory2recomp' })] })), 'ToyStory2Recomp');
    assert.equal(p.documentId, 'b9f1c2d3-legacy');
    assert.equal(p.operation, 'UNCHANGED');
  });

  it('conflicting editorial values → BLOCKED with a field comparison; nothing is overwritten', () => {
    const plan = planMigration(input({ existing: [ts2({ title: 'Toy Story 2 (CMS)', featuredOrder: 7 })] }));
    const p = byRepo(plan, 'ToyStory2Recomp');
    assert.equal(p.operation, 'BLOCKED');
    assert.deepEqual(p.comparison.filter((c) => c.status === 'conflict').map((c) => [c.field, c.existing, c.proposed]), [['title', 'Toy Story 2 (CMS)', 'Toy Story 2 Recomp'], ['featuredOrder', 7, 0]]);
    assert.equal(p.fields.title, 'Toy Story 2 (CMS)'); // existing value kept
    assert.match(renderReport(plan), /\| title \| Toy Story 2 \(CMS\) \| Toy Story 2 Recomp \| conflict \|/);
  });

  it('duplicate documents for one repository → BLOCKED, no ID chosen', () => {
    const p = byRepo(planMigration(input({ existing: [ts2({ _id: 'a' }), ts2({ _id: 'b', repo: 'TOYSTORY2RECOMP' })] })), 'ToyStory2Recomp');
    assert.equal(p.operation, 'BLOCKED');
    assert.equal(p.documentId, null);
    assert.match(p.reasons[0], /Duplicate Sanity documents.*a, b/);
  });

  it('a proposed ID already owned by another repository → BLOCKED', () => {
    const p = byRepo(planMigration(input({ existing: [{ _id: 'project-psxrecomp', repo: 'SomethingElse' }] })), 'psxrecomp');
    assert.equal(p.operation, 'BLOCKED');
  });

  it('lists documents the plan does not cover', () => {
    assert.deepEqual(planMigration(input({ existing: [{ _id: 'project-x', repo: 'Unrelated' }] })).untouchedSanityDocuments, ['project-x (Unrelated)']);
  });

  it('an existing screenshot in Sanity is reported and left alone', () => {
    const p = byRepo(planMigration(input({ existing: [ts2({ screenshots: [{ alt: 'x', assetRef: 'image-abc-10x10-png' }] })] })), 'ToyStory2Recomp');
    assert.equal(p.screenshot.kind, 'in-sanity');
  });
});

describe('validation', () => {
  it('invalid values → BLOCKED with the website validation reason', () => {
    const broken = { ...projectOverrides, psxrecomp: { ...projectOverrides.psxrecomp, category: 'consoles' as never } };
    const p = byRepo(planMigration(input({ config: { ...config, projectOverrides: broken } })), 'psxrecomp');
    assert.equal(p.operation, 'BLOCKED');
    assert.match(p.reasons.join(' '), /invalid category/);
  });

  it('Studio schema errors → BLOCKED', () => {
    const p = byRepo(planMigration(input({ schemaErrors: new Map([['project-recomp-ui', ['tags: At most 2 tags']]]) })), 'recomp-ui');
    assert.equal(p.operation, 'BLOCKED');
    assert.match(p.reasons.join(' '), /Schema validation: tags: At most 2 tags/);
  });

  it('every proposed document passes the real Studio schema (incl. duplicate check)', { skip: studioReady ? false : 'Studio dependencies not installed' }, async () => {
    const plan = planMigration(input());
    const errors = await validateWithStudioSchema(root, proposedDocuments(plan) as never, []);
    assert.ok(errors);
    assert.deepEqual([...errors!.values()].flat(), []);
    const dup = await validateWithStudioSchema(root, [{ _id: 'x1', _type: 'project', repo: 'ToyStory2Recomp' }], [{ _id: 'project-toystory2recomp', repo: 'toystory2recomp' }]);
    assert.match(dup!.get('x1')!.join(' '), /already used/);
  });
});

describe('GitHub inventory', () => {
  it('skips proposals for repositories GitHub does not return', () => {
    const plan = planMigration(input({ repos: inventory.filter((r) => r.name !== 'RescueShotRecomp') }));
    assert.equal(byRepo(plan, 'RescueShotRecomp').operation, 'SKIP');
    assert.deepEqual(plan.missingRepositories, ['RescueShotRecomp']);
  });

  it('falls back to the snapshot when GitHub is unavailable – and says what that means', async () => {
    const { fetchImpl } = sanityStub([]);
    const inputs = await collectInputs({
      env, root, config, githubUser: 'PeriBluGaming', fallback, fetchImpl,
      fetchRepos: async () => Promise.reject(new Error('rate limited')),
    });
    assert.match(inputs.githubSource, /^FALLBACK snapshot from 2026-11-02.*rate limited.*SKIPPED/);
    const plan = planMigration(input({ repos: inputs.repos, githubSource: inputs.githubSource }));
    assert.equal(byRepo(plan, 'SledStormPSXRecomp').operation, 'SKIP'); // not in the snapshot
    assert.match(renderReport(plan), /FALLBACK snapshot/);
  });
});

describe('read-only inputs', () => {
  it('detects local screenshots without Sanity assets, and identical assets that exist', async () => {
    const ts2Sha = sha1('/images/projects/toystory2/gameplay.png');
    const { fetchImpl } = sanityStub([], [{ _id: 'image-f120980f-1920x1080-png', sha1hash: ts2Sha }]);
    const inputs = await collectInputs({ env, root, config, githubUser: 'PeriBluGaming', fallback, fetchImpl, fetchRepos: async () => inventory });
    const shots = new Map(inputs.screenshots.map((s) => [s.repo, s]));
    assert.equal(shots.get('ToyStory2Recomp')!.sanityAssetId, 'image-f120980f-1920x1080-png');
    assert.equal(shots.get('romm2switch')!.sanityAssetId, null);
    assert.ok([...shots.values()].every((s) => s.exists && s.sha1));
    const plan = planMigration(input({ screenshots: inputs.screenshots }));
    assert.equal(byRepo(plan, 'ToyStory2Recomp').screenshot.kind, 'asset-exists');
    assert.equal(plan.summary.screenshotUploads, 4);
  });

  it('an empty Sanity collection is valid', async () => {
    const { fetchImpl } = sanityStub([]);
    const inputs = await collectInputs({ env, root, config, githubUser: 'PeriBluGaming', fallback, fetchImpl, fetchRepos: async () => inventory });
    assert.deepEqual(inputs.existing, []);
  });

  it('aborts instead of guessing when Sanity cannot be read', async () => {
    const opts = { root, config, githubUser: 'PeriBluGaming', fallback, fetchRepos: async () => inventory };
    await assert.rejects(collectInputs({ ...opts, env, fetchImpl: sanityStub([], [], 503).fetchImpl }), (e: Error) => e instanceof MigrationAbort && /HTTP 503/.test(e.message));
    await assert.rejects(collectInputs({ ...opts, env, fetchImpl: sanityStub({ not: 'a list' }).fetchImpl }), /unexpected response/);
    await assert.rejects(collectInputs({ ...opts, env: {}, fetchImpl: sanityStub([]).fetchImpl }), /SANITY_PROJECT_ID is not set/);
  });
});

describe('no production-write capability', () => {
  it('only issues tokenless GET queries – even with credentials in the environment', async () => {
    const { fetchImpl, requests } = sanityStub([], []);
    let githubOptions: unknown;
    await collectInputs({
      env: { ...env, SANITY_READ_TOKEN: 'skREAD', SANITY_WRITE_TOKEN: 'skWRITE', SANITY_AUTH_TOKEN: 'skAUTH', GITHUB_TOKEN: 'ghp_x' },
      root, config, githubUser: 'PeriBluGaming', fallback, fetchImpl,
      fetchRepos: async (_user, options) => ((githubOptions = options), inventory),
    });
    assert.deepEqual(githubOptions, {}); // no GitHub token either
    assert.equal(requests.length, 2);
    for (const { url, init } of requests) {
      assert.equal(init?.method, 'GET');
      assert.equal(init?.credentials, 'omit');
      assert.match(url.pathname, /^\/v2025-02-19\/data\/query\/production$/);
      assert.doesNotMatch(JSON.stringify(init?.headers), /sk|Authorization|Bearer/i);
    }
  });

  it('refuses mutation, asset and other endpoints before sending anything', async () => {
    let sent = 0;
    const get = readOnlySanityFetch((async () => (sent++, new Response('{}'))) as typeof fetch);
    for (const url of [
      'https://hyyn359x.api.sanity.io/v2025-02-19/data/mutate/production',
      'https://hyyn359x.api.sanity.io/v2025-02-19/assets/images/production',
      'https://api.sanity.io/v2025-02-19/projects/hyyn359x',
      'http://hyyn359x.api.sanity.io/v2025-02-19/data/query/production',
      'https://evil.example/v2025-02-19/data/query/production',
    ]) {
      await assert.rejects(get(new URL(url)), /refusing non-query Sanity request/, url);
    }
    assert.equal(sent, 0);
  });

  it('contains no Sanity client or write API at all', () => {
    for (const file of ['src/lib/project-migration.ts', 'src/lib/project-migration-io.ts', 'scripts/sanity-project-migration-dry-run.ts']) {
      const code = readFileSync(join(root, file), 'utf8');
      assert.doesNotMatch(code, /@sanity\/client|createClient|\.mutate\(|createOrReplace|createIfNotExists|\.patch\(|\.delete\(|assets\.upload|\/data\/mutate|method: 'POST'/, file);
    }
  });

  it('the plan is marked non-executable and contains no credentials', () => {
    const plan = planMigration(input());
    assert.equal(plan.dryRun, true);
    assert.equal(plan.executable, false);
    assert.doesNotMatch(JSON.stringify(plan), /token|Bearer|\bsk[A-Za-z0-9]{8,}/i);
  });

  it('the CLI has no write mode: unknown flags are rejected before any work', () => {
    for (const flag of ['--execute', '--write', '--apply']) {
      const r = spawnSync(process.execPath, [join(root, 'scripts/sanity-project-migration-dry-run.ts'), flag], { encoding: 'utf8', env: {} });
      assert.equal(r.status, 2, flag);
      assert.match(r.stderr, /dry run only – there is no write mode/);
    }
  });
});
