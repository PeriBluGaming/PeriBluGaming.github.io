/**
 * Reliability of project detail pages: page manifest and deployment guard (src/lib/page-manifest.ts,
 * guardPages), slug preservation (selectProjectPages with published pages), release resilience
 * (src/lib/github-releases.ts) and the 15-minute release check (decideReleases, decideWithReleases). No network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { categories, retiredDetailPages } from '../src/config/projects.ts';
import {
  DAILY_REFRESH_CRON,
  createBuildInfo,
  decideDeploy,
  decideReleases,
  decideWithReleases,
  fetchCurrentReleases,
  forceReason,
  guardPages,
  liveSiteState,
  parseBuildInfo,
  type LiveBuildInfo,
  type ReleaseLookup,
} from '../src/lib/deploy-check.ts';
import { createReleaseLoader, fetchLatestRelease, normalizeRelease, toManifestRelease, type LatestRelease } from '../src/lib/github-releases.ts';
import { GitHubApiError } from '../src/lib/github.ts';
import {
  MANIFEST_SCHEMA,
  compareManifests,
  createManifest,
  fetchLiveManifest,
  parseManifest,
  resolveLiveManifest,
  type LiveManifest,
  type ManifestPage,
  type ManifestRelease,
  type PageManifest,
} from '../src/lib/page-manifest.ts';
import type { VisibleEntry } from '../src/lib/project-merge.ts';
import { selectProjectPages } from '../src/lib/project-pages.ts';

const SHA = 'a'.repeat(40);
const rel = (repo: string, id: number, version = `v${id}`): ManifestRelease => ({
  id,
  version,
  url: `https://github.com/PeriBluGaming/${repo}/releases/tag/${version}`,
  publishedAt: '2026-10-30T12:00:00.000Z',
});
const page = (repo: string, slug: string, release: ManifestRelease | null = null, releaseStatus?: ManifestPage['releaseStatus']): ManifestPage => ({
  repo,
  slug,
  release,
  releaseStatus: releaseStatus ?? (release ? 'fetched' : 'none'),
});
const manifest = (...pages: ManifestPage[]): PageManifest => createManifest(pages);
const TOY = page('ToyStory2Recomp', 'toystory2recomp', rel('ToyStory2Recomp', 11));
const ROMM = page('romm2switch', 'romm2switch');
const LIVE = manifest(TOY, ROMM);

const infoWithManifest: LiveBuildInfo = { state: 'found', info: { ...createBuildInfo(SHA, null, new Date(0), MANIFEST_SCHEMA) } };
const infoPreManifest: LiveBuildInfo = { state: 'found', info: createBuildInfo(SHA, null, new Date(0)) };
const found = (m: PageManifest): LiveManifest => ({ state: 'found', manifest: m });
const guard = (next: unknown, liveManifest: LiveManifest = found(LIVE), liveInfo: LiveBuildInfo = infoWithManifest, retired: Record<string, string> = {}) =>
  guardPages({ next, liveInfo, liveManifest, retired });

// ── Manifest format ────────────────────────────────────────────────────────────────────────────────────────────

describe('page manifest format', () => {
  it('round-trips, sorted by slug', () => {
    const m = manifest(page('b', 'b'), page('A', 'a', rel('A', 1)));
    assert.deepEqual(m.pages.map((p) => p.slug), ['a', 'b']);
    assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(m))), { ok: true, manifest: m });
  });

  it('rejects malformed or inconsistent manifests', () => {
    const cases: [string, unknown, RegExp][] = [
      ['not an object', 'x', /not an object/],
      ['wrong schema', { schemaVersion: 2, pages: [] }, /schemaVersion/],
      ['no list', { schemaVersion: 1 }, /not a list/],
      ['bad repo', { schemaVersion: 1, pages: [page('a b', 'x')] }, /invalid repository/],
      ['bad slug', { schemaVersion: 1, pages: [page('A', 'Not OK')] }, /invalid slug/],
      ['duplicate slug', { schemaVersion: 1, pages: [page('A', 'x'), page('B', 'x')] }, /slug "x" is used twice/],
      ['duplicate repo (case-insensitive)', { schemaVersion: 1, pages: [page('A', 'x'), page('a', 'y')] }, /listed twice/],
      ['bad status', { schemaVersion: 1, pages: [{ ...page('A', 'a'), releaseStatus: 'maybe' }] }, /release status/],
      ['fetched without release', { schemaVersion: 1, pages: [{ ...page('A', 'a'), releaseStatus: 'fetched' }] }, /contradicts/],
      ['none with release', { schemaVersion: 1, pages: [{ ...page('A', 'a', rel('A', 1)), releaseStatus: 'none' }] }, /contradicts/],
      ['foreign release URL', { schemaVersion: 1, pages: [page('A', 'a', { ...rel('A', 1), url: 'https://evil.com/PeriBluGaming/A/releases/tag/v1' })] }, /invalid release/],
      ['release of another repo', { schemaVersion: 1, pages: [page('A', 'a', rel('B', 1))] }, /invalid release/],
      ['release without id', { schemaVersion: 1, pages: [page('A', 'a', { ...rel('A', 1), id: 0 })] }, /invalid release/],
    ];
    for (const [label, json, reason] of cases) {
      const r = parseManifest(json);
      assert.equal(r.ok, false, label);
      if (!r.ok) assert.match(r.reason, reason, label);
    }
  });

  it('build info declares the manifest; older build info stays readable', () => {
    assert.equal(createBuildInfo(SHA, null, new Date(0), MANIFEST_SCHEMA).manifest, 1);
    assert.equal('manifest' in createBuildInfo(SHA, null, new Date(0)), false);
    assert.ok(parseBuildInfo({ schema: 1, commit: SHA, builtAt: 'x', content: null }));
    assert.equal(parseBuildInfo({ schema: 1, commit: SHA, builtAt: 'x', content: null, manifest: 'yes' }), null);
  });
});

describe('fetchLiveManifest', () => {
  const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  it('only a real 404 counts as missing', async () => {
    assert.deepEqual(await fetchLiveManifest('https://x.test', { fetchImpl: respond(404, 'Not found') }), { state: 'missing' });
  });
  it('treats 403, 500, invalid JSON, invalid content and network errors as unreadable', async () => {
    for (const [label, impl] of [
      ['403', respond(403, '')],
      ['500', respond(500, '')],
      ['html', respond(200, '<!doctype html>')],
      ['bad manifest', respond(200, '{"schemaVersion":1,"pages":[{"repo":"A","slug":"x"},{"repo":"B","slug":"x"}]}')],
      ['network', (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch],
    ] as const) {
      const live = await fetchLiveManifest('https://x.test', { fetchImpl: impl });
      assert.equal(live.state, 'unreadable', label);
    }
  });
  it('bypasses the CDN cache and parses a valid manifest', async () => {
    let requested = '';
    const live = await fetchLiveManifest('https://x.test', {
      fetchImpl: (async (url: URL) => {
        requested = String(url);
        return new Response(JSON.stringify(LIVE));
      }) as unknown as typeof fetch,
    });
    assert.match(requested, /^https:\/\/x\.test\/projects\/pages\.json\?nocache=\d+$/);
    assert.deepEqual(live, found(LIVE));
  });
});

// ── Bootstrap ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('first publication (bootstrap)', () => {
  it('derives the live site state from build-info.json', () => {
    assert.equal(liveSiteState(infoWithManifest), 'uses-manifest');
    assert.equal(liveSiteState(infoPreManifest), 'pre-manifest');
    assert.equal(liveSiteState({ state: 'missing' }), 'no-site');
    assert.equal(liveSiteState({ state: 'unreadable', reason: 'HTTP 500' }), 'unknown');
  });

  it('accepts a missing manifest only on a pre-manifest site or a site that was never published', () => {
    assert.equal(resolveLiveManifest('pre-manifest', { state: 'missing' }).state, 'bootstrap');
    assert.equal(resolveLiveManifest('no-site', { state: 'missing' }).state, 'bootstrap');
    assert.equal(resolveLiveManifest('uses-manifest', { state: 'missing' }).state, 'refuse');
    assert.equal(resolveLiveManifest('unknown', { state: 'missing' }).state, 'refuse');
  });

  it('never treats an unreadable manifest as a first publication', () => {
    for (const site of ['pre-manifest', 'no-site', 'uses-manifest', 'unknown'] as const) {
      assert.equal(resolveLiveManifest(site, { state: 'unreadable', reason: 'HTTP 500' }).state, 'refuse', site);
    }
  });

  it('guard: verified initial rollout deploys; unreadable manifest on an established site is refused', () => {
    assert.equal(guard(LIVE, { state: 'missing' }, infoPreManifest).deploy, true);
    const refused = guard(LIVE, { state: 'unreadable', reason: 'HTTP 503' }, infoWithManifest);
    assert.equal(refused.deploy, false);
    assert.match(refused.reason, /unreadable \(HTTP 503\)/);
    assert.equal(guard(LIVE, { state: 'missing' }, infoWithManifest).deploy, false);
    assert.equal(guard(LIVE, { state: 'missing' }, { state: 'unreadable', reason: 'timeout' }).deploy, false);
  });
});

// ── Deployment guard ───────────────────────────────────────────────────────────────────────────────────────────

describe('deployment guard', () => {
  it('deploys an unchanged manifest', () => {
    const r = guard(LIVE);
    assert.equal(r.deploy, true);
    assert.match(r.reason, /all 2 published page\(s\) kept/);
  });

  it('deploys newly added pages', () => {
    const r = guard(manifest(...LIVE.pages, page('psxrecomp', 'psxrecomp')));
    assert.equal(r.deploy, true);
    assert.match(r.reason, /1 new/);
  });

  it('refuses when a published page is missing (e.g. GitHub fallback snapshot without the repository)', () => {
    const r = guard(manifest(TOY));
    assert.equal(r.deploy, false);
    assert.deepEqual(r.problems, ['published page romm2switch (/projects/romm2switch/) would disappear']);
  });

  it('refuses when a published slug changes', () => {
    const r = guard(manifest(page('ToyStory2Recomp', 'toy-story-2', rel('ToyStory2Recomp', 11)), ROMM));
    assert.match(r.problems.join(), /would move from "toystory2recomp" to "toy-story-2"/);
  });

  it('refuses when a published slug is assigned to another repository', () => {
    const r = guard(manifest(page('ToyStory2Recomp', 'toystory2recomp-2', rel('ToyStory2Recomp', 11)), page('Other', 'toystory2recomp'), ROMM));
    assert.equal(r.deploy, false);
    assert.match(r.problems.join('\n'), /slug "toystory2recomp" \(ToyStory2Recomp\) would be reassigned to Other/);
  });

  it('refuses a repository rename (identity change) instead of silently moving the page', () => {
    const r = guard(manifest(page('ToyStory2Recompiled', 'toystory2recomp', rel('ToyStory2Recompiled', 11)), ROMM));
    assert.equal(r.deploy, false);
    assert.match(r.problems.join('\n'), /reassigned to ToyStory2Recompiled/);
    assert.match(r.problems.join('\n'), /ToyStory2Recomp \(\/projects\/toystory2recomp\/\) would disappear/);
  });

  it('refuses duplicate slugs and malformed manifests in the build', () => {
    assert.match(guard({ schemaVersion: 1, pages: [page('A', 'x'), page('B', 'x')] }).reason, /invalid.*used twice/);
    assert.match(guard(null).reason, /invalid/);
    assert.equal(guard({ schemaVersion: 1, pages: 'all' }).deploy, false);
  });

  it('allows removal only through retiredDetailPages with the same repository and slug', () => {
    const without = manifest(TOY);
    assert.equal(guard(without, found(LIVE), infoWithManifest, { romm2switch: 'romm2switch' }).deploy, true);
    assert.equal(guard(without, found(LIVE), infoWithManifest, { romm2switch: 'other-slug' }).deploy, false);
    assert.equal(guard(without, found(LIVE), infoWithManifest, { SomethingElse: 'romm2switch' }).deploy, false);
    // A retired slug can never be handed to another project.
    const reuse = guard(manifest(TOY, page('NewProject', 'romm2switch')), found(LIVE), infoWithManifest, { romm2switch: 'romm2switch' });
    assert.equal(reuse.deploy, false);
    assert.match(reuse.reason, /retired slug "romm2switch" is used by NewProject/);
  });

  it('refuses when a published release would disappear because GitHub was unavailable', () => {
    const r = guard(manifest(page('ToyStory2Recomp', 'toystory2recomp', null, 'unavailable'), ROMM));
    assert.match(r.problems.join(), /release v11 of ToyStory2Recomp would disappear/);
    // Confirmed removal (404 → "none") and reuse ("previous") are fine.
    assert.equal(guard(manifest(page('ToyStory2Recomp', 'toystory2recomp', null, 'none'), ROMM)).deploy, true);
    assert.equal(guard(manifest(page('ToyStory2Recomp', 'toystory2recomp', rel('ToyStory2Recomp', 11), 'previous'), ROMM)).deploy, true);
    // Nothing published before → "unavailable" is allowed.
    assert.equal(guard(manifest(TOY, page('romm2switch', 'romm2switch', null, 'unavailable'))).deploy, true);
  });

  it('the repository configuration retires nothing', () => {
    assert.deepEqual(retiredDetailPages, {});
  });

  it('compareManifests compares repositories case-insensitively', () => {
    assert.equal(compareManifests({ live: LIVE, next: manifest(page('toystory2recomp', 'toystory2recomp', rel('toystory2recomp', 11)), ROMM) }).ok, true);
  });
});

// ── Slug and page preservation in the build ────────────────────────────────────────────────────────────────────

const entry = (name: string, featured = false): VisibleEntry => ({
  project: {
    name,
    title: name,
    description: null,
    url: `https://github.com/PeriBluGaming/${name}`,
    category: categories[0],
    tags: [],
    language: null,
    stars: 0,
    pushedAt: '2026-01-01T00:00:00Z',
    fork: false,
    archived: false,
    featured,
  },
  accent: 'cyan',
});
const select = (visible: VisibleEntry[], publishedPages: Record<string, string>, extra: { localPages?: Record<string, string>; retiredPages?: Record<string, string>; slug?: [string, string] } = {}) =>
  selectProjectPages({
    visible,
    overrides: new Map(extra.slug ? [[extra.slug[0].toLowerCase(), { repo: extra.slug[0], sourceId: 'p', updatedAt: '', slug: extra.slug[1] }]] : []),
    localPages: extra.localPages ?? {},
    publishedPages,
    retiredPages: extra.retiredPages,
  });
const slugs = (r: ReturnType<typeof select>) => Object.fromEntries(r.pages.map((p) => [p.project.name, [p.slug, p.reason]]));

describe('page and slug preservation from the live manifest', () => {
  it('keeps a published page after the project lost its featured status outside the Studio', () => {
    assert.deepEqual(slugs(select([entry('Alpha')], { Alpha: 'alpha' })), { Alpha: ['alpha', 'published'] });
  });

  it('a new colliding project gets the suffix, the published page keeps its URL', () => {
    // Without the live manifest "Foo-Bar" (sorts first) would take "foo-bar" from the published "Foo_Bar".
    const r = select([entry('Foo_Bar', true), entry('Foo-Bar', true)], { Foo_Bar: 'foo-bar' });
    assert.deepEqual(slugs(r), { Foo_Bar: ['foo-bar', 'featured'], 'Foo-Bar': ['foo-bar-2', 'featured'] });
  });

  it('a new stored Sanity slug can not take a published URL', () => {
    const r = select([entry('Alpha', true), entry('Beta', true)], { Alpha: 'alpha' }, { slug: ['Beta', 'alpha'] });
    assert.deepEqual(slugs(r), { Alpha: ['alpha', 'featured'], Beta: ['alpha-2', 'featured'] });
  });

  it('published slug wins over a changed Sanity or local slug (URL stays, warning)', () => {
    const r = select([entry('Alpha', true)], { Alpha: 'alpha' }, { slug: ['Alpha', 'alpha-renamed'], localPages: { Alpha: 'alpha-local' } });
    assert.equal(r.pages[0].slug, 'alpha');
    assert.match(r.warnings.join('\n'), /configured slug "alpha-local".*keeping the published URL/);
    assert.match(r.warnings.join('\n'), /Sanity slug "alpha-renamed".*using the published one/);
  });

  it('is stable across repeated builds', () => {
    const first = select([entry('Foo_Bar', true), entry('Foo-Bar', true), entry('X')], {});
    const published = Object.fromEntries(first.pages.map((p) => [p.project.name, p.slug]));
    const second = select([entry('Foo_Bar', true), entry('Foo-Bar', true), entry('Zed', true), entry('X')], published);
    for (const p of first.pages) assert.equal(second.pages.find((q) => q.project.name === p.project.name)?.slug, p.slug);
  });

  it('retired pages are not rendered and their slugs stay reserved', () => {
    const r = select([entry('Old', true), entry('New', true)], {}, { retiredPages: { Old: 'new' } });
    assert.deepEqual(slugs(r), { New: ['new-2', 'featured'] });
  });

  it('a published repository missing from GitHub data gets no page – the guard catches it', () => {
    const r = select([], { Gone: 'gone' });
    assert.deepEqual(r.pages, []);
    const next = manifest();
    assert.equal(guard(next, found(manifest(page('Gone', 'gone')))).deploy, false);
  });
});

// ── Release fetching and resilience ────────────────────────────────────────────────────────────────────────────

const apiRelease = (id = 101, tag = 'v1.2.0', repo = 'ToyStory2Recomp') => ({
  id,
  tag_name: tag,
  name: `${repo} ${tag}`,
  html_url: `https://github.com/PeriBluGaming/${repo}/releases/tag/${tag}`,
  published_at: '2026-10-30T12:00:00Z',
  draft: false,
  prerelease: false,
  assets: [{ browser_download_url: 'https://example.com/x.zip' }],
});
const response = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

describe('fetchLatestRelease', () => {
  it('keeps only id, version, name, date and the release page URL', async () => {
    const r = await fetchLatestRelease('PeriBluGaming', 'ToyStory2Recomp', { fetchImpl: response(200, apiRelease()) });
    assert.deepEqual(r, {
      id: 101,
      version: 'v1.2.0',
      name: 'ToyStory2Recomp v1.2.0',
      publishedAt: '2026-10-30T12:00:00.000Z',
      url: 'https://github.com/PeriBluGaming/ToyStory2Recomp/releases/tag/v1.2.0',
    });
  });

  it('returns null only for a confirmed absence (404)', async () => {
    assert.equal(await fetchLatestRelease('PeriBluGaming', 'NoRelease', { fetchImpl: response(404, { message: 'Not Found' }) }), null);
  });

  it('throws on 403, 429, 5xx, network errors, timeouts, invalid JSON and unexpected data', async () => {
    const cases: [string, typeof fetch][] = [
      ['403', response(403, {}, { 'x-ratelimit-remaining': '0' })],
      ['429', response(429)],
      ['500', response(500)],
      ['502', response(502)],
      ['invalid JSON', response(200, '<html>')],
      ['foreign URL', response(200, { ...apiRelease(), html_url: 'https://evil.com/x' })],
      ['missing id', response(200, { ...apiRelease(), id: undefined })],
      ['network', (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch],
      ['timeout', (async () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))) as unknown as typeof fetch],
    ];
    for (const [label, fetchImpl] of cases) {
      await assert.rejects(fetchLatestRelease('PeriBluGaming', 'ToyStory2Recomp', { fetchImpl }), label);
    }
    await assert.rejects(fetchLatestRelease('PeriBluGaming', 'X', { fetchImpl: response(429) }), (e: unknown) => e instanceof GitHubApiError && e.rateLimited);
  });

  it('rejects drafts, prereleases and releases of other repositories', () => {
    assert.equal(normalizeRelease({ ...apiRelease(), draft: true }, 'PeriBluGaming', 'ToyStory2Recomp'), null);
    assert.equal(normalizeRelease({ ...apiRelease(), prerelease: true }, 'PeriBluGaming', 'ToyStory2Recomp'), null);
    assert.equal(normalizeRelease(apiRelease(1, 'v1', 'Other'), 'PeriBluGaming', 'ToyStory2Recomp'), null);
  });
});

describe('release loader (build)', () => {
  const previous = new Map([['toystory2recomp', rel('ToyStory2Recomp', 11, 'v1.1.0')]]);
  const loader = (fetchRelease: typeof fetchLatestRelease, prev = previous, env: Record<string, string> = {}) => {
    const warnings: string[] = [];
    return { load: createReleaseLoader({ owner: 'PeriBluGaming', env, fetchRelease, previousReleases: async () => prev, log: { warn: (m) => warnings.push(m) } }), warnings };
  };
  const ok = (r: unknown) => (async () => r) as unknown as typeof fetchLatestRelease;
  const fail = (msg: string) => (async () => Promise.reject(new GitHubApiError(msg, 503))) as unknown as typeof fetchLatestRelease;
  const latest = (id: number, version: string): LatestRelease => normalizeRelease(apiRelease(id, version), 'PeriBluGaming', 'ToyStory2Recomp')!;

  it('successful fetch: uses (and replaces the previous with) the new release', async () => {
    const r = await loader(ok(latest(202, 'v2.0.0'))).load('ToyStory2Recomp');
    assert.deepEqual([r.status, r.release?.id, r.release?.version], ['fetched', 202, 'v2.0.0']);
  });

  it('confirmed no release: shows none, even if one was published before', async () => {
    assert.deepEqual(await loader(ok(null)).load('ToyStory2Recomp'), { release: null, status: 'none' });
  });

  it('temporary error with a valid previous release: reuses it', async () => {
    const { load, warnings } = loader(fail('GitHub API responded 503'));
    const r = await load('ToyStory2Recomp');
    assert.equal(r.status, 'previous');
    assert.deepEqual(r.release && toManifestRelease(r.release), rel('ToyStory2Recomp', 11, 'v1.1.0'));
    assert.match(warnings[0], /reusing the published v1\.1\.0/);
  });

  it('temporary error without previous release: hides the section', async () => {
    assert.deepEqual(await loader(fail('503'), new Map()).load('ToyStory2Recomp'), { release: null, status: 'unavailable' });
  });

  it('never reuses an invalid cached release URL', async () => {
    const bad = new Map([['toystory2recomp', { ...rel('ToyStory2Recomp', 11), url: 'https://evil.com/PeriBluGaming/ToyStory2Recomp/releases/tag/v1' }]]);
    assert.deepEqual(await loader(fail('503'), bad).load('ToyStory2Recomp'), { release: null, status: 'unavailable' });
    const otherRepo = new Map([['toystory2recomp', rel('Other', 11)]]);
    assert.equal((await loader(fail('503'), otherRepo).load('ToyStory2Recomp')).status, 'unavailable');
  });

  it('if the live manifest itself is unavailable, nothing is invented', async () => {
    const load = createReleaseLoader({ owner: 'PeriBluGaming', env: {}, fetchRelease: fail('503'), previousReleases: async () => Promise.reject(new Error('offline')), log: { warn() {} } });
    assert.deepEqual(await load('ToyStory2Recomp'), { release: null, status: 'unavailable' });
  });

  it('GITHUB_OFFLINE=1 skips the API and behaves like a GitHub failure', async () => {
    const r = await loader(async () => assert.fail('no request'), previous, { GITHUB_OFFLINE: '1' }).load('ToyStory2Recomp');
    assert.equal(r.status, 'previous');
  });

  it('caches one request per repository', async () => {
    let calls = 0;
    const { load } = loader((async () => (calls++, latest(1, 'v1'))) as unknown as typeof fetchLatestRelease);
    await load('ToyStory2Recomp');
    await load('toystory2recomp');
    assert.equal(calls, 1);
  });
});

// ── 15-minute release change detection ─────────────────────────────────────────────────────────────────────────

const lookups = (entries: [string, ReleaseLookup][]) => new Map(entries.map(([k, v]) => [k.toLowerCase(), v]));
const okLookup = (r: LatestRelease | null): ReleaseLookup => ({ ok: true, release: r });
const asLatest = (m: ManifestRelease): LatestRelease => ({ ...m });

describe('decideReleases', () => {
  const pages = LIVE.pages; // ToyStory2Recomp: #11, romm2switch: none
  it('no release changes → unchanged', () => {
    const r = decideReleases(pages, lookups([['ToyStory2Recomp', okLookup(asLatest(rel('ToyStory2Recomp', 11)))], ['romm2switch', okLookup(null)]]));
    assert.equal(r.state, 'unchanged');
  });
  it('new release → changed', () => {
    const r = decideReleases(pages, lookups([['ToyStory2Recomp', okLookup(asLatest(rel('ToyStory2Recomp', 11)))], ['romm2switch', okLookup(asLatest(rel('romm2switch', 5)))]]));
    assert.equal(r.state, 'changed');
    assert.match(r.reason, /romm2switch: none → v5 \(#5\)/);
  });
  it('replacement (new ID) → changed, also with the same tag', () => {
    const sameTag = decideReleases(pages, lookups([['ToyStory2Recomp', okLookup(asLatest(rel('ToyStory2Recomp', 12, 'v11')))], ['romm2switch', okLookup(null)]]));
    assert.equal(sameTag.state, 'changed');
    assert.match(sameTag.reason, /v11 \(#11\) → v11 \(#12\)/);
  });
  it('removal → changed', () => {
    const r = decideReleases(pages, lookups([['ToyStory2Recomp', okLookup(null)], ['romm2switch', okLookup(null)]]));
    assert.equal(r.state, 'changed');
    assert.match(r.reason, /v11 \(#11\) → none/);
  });
  it('API error → unknown, never unchanged; a change elsewhere still builds', () => {
    const errorOnly = decideReleases(pages, lookups([['ToyStory2Recomp', { ok: false, reason: 'HTTP 502' }], ['romm2switch', okLookup(null)]]));
    assert.equal(errorOnly.state, 'unknown');
    assert.match(errorOnly.reason, /ToyStory2Recomp: HTTP 502/);
    const withChange = decideReleases(pages, lookups([['ToyStory2Recomp', { ok: false, reason: 'HTTP 502' }], ['romm2switch', okLookup(asLatest(rel('romm2switch', 5)))]]));
    assert.equal(withChange.state, 'changed');
    assert.equal(decideReleases(pages, new Map()).state, 'unknown');
  });
  it('a page whose release was reused or unavailable in the last build is rechecked by ID', () => {
    const reused = [page('ToyStory2Recomp', 'toystory2recomp', rel('ToyStory2Recomp', 11), 'previous')];
    assert.equal(decideReleases(reused, lookups([['ToyStory2Recomp', okLookup(asLatest(rel('ToyStory2Recomp', 11)))]])).state, 'unchanged');
    const missed = [page('ToyStory2Recomp', 'toystory2recomp', null, 'unavailable')];
    assert.equal(decideReleases(missed, lookups([['ToyStory2Recomp', okLookup(asLatest(rel('ToyStory2Recomp', 11)))]])).state, 'changed');
  });
});

describe('fetchCurrentReleases', () => {
  it('uses the same /releases/latest call per page, retries once, passes the token, records failures', async () => {
    const calls: string[] = [];
    let flaky = 0;
    const fetchRelease = (async (_o: string, repo: string, opts: { token?: string }) => {
      calls.push(`${repo}:${opts.token}`);
      if (repo === 'romm2switch' && flaky++ === 0) throw new Error('ECONNRESET');
      if (repo === 'Broken') throw new Error('HTTP 500');
      return null;
    }) as unknown as typeof fetchLatestRelease;
    const pages = [...LIVE.pages, page('Broken', 'broken')];
    const r = await fetchCurrentReleases('PeriBluGaming', pages, { token: 't', fetchRelease, delayMs: 0 });
    assert.deepEqual(r.get('romm2switch'), { ok: true, release: null });
    assert.deepEqual(r.get('broken'), { ok: false, reason: 'HTTP 500' });
    assert.deepEqual(calls, ['romm2switch:t', 'romm2switch:t', 'ToyStory2Recomp:t', 'Broken:t', 'Broken:t']);
  });
});

describe('decideWithReleases (scheduled check)', () => {
  const unchanged = { changed: false, reason: 'no changes since the live build' };
  const never = async () => assert.fail('must not be called');
  const run = (base: { changed: boolean; reason: string }, opts: { liveInfo?: LiveBuildInfo; manifest?: LiveManifest; releases?: Map<string, ReleaseLookup> } = {}) =>
    decideWithReleases({
      base,
      liveInfo: opts.liveInfo ?? infoWithManifest,
      loadManifest: async () => opts.manifest ?? found(LIVE),
      loadReleases: async () => opts.releases ?? new Map(),
    });
  const same = lookups([['ToyStory2Recomp', okLookup(asLatest(rel('ToyStory2Recomp', 11)))], ['romm2switch', okLookup(null)]]);

  it('release-only change triggers a build', async () => {
    const d = await run(unchanged, { releases: lookups([['ToyStory2Recomp', okLookup(asLatest(rel('ToyStory2Recomp', 12)))], ['romm2switch', okLookup(null)]]) });
    assert.equal(d.changed, true);
    assert.match(d.reason, /release changed/);
  });

  it('unchanged releases do not trigger a build', async () => {
    const d = await run(unchanged, { releases: same });
    assert.deepEqual(d, { changed: false, reason: 'no changes since the live build; releases unchanged (2 page(s))' });
  });

  it('daily, manual and Sanity/code-triggered builds still build – without any release request', async () => {
    const reasons = [forceReason('schedule', DAILY_REFRESH_CRON)!, forceReason('workflow_dispatch', undefined)!, 'content changed (3 → 4 visible documents)'];
    assert.ok(reasons.every(Boolean));
    for (const reason of reasons) {
      const d = await decideWithReleases({ base: { changed: true, reason }, liveInfo: infoWithManifest, loadManifest: never, loadReleases: never });
      assert.deepEqual(d, { changed: true, reason });
    }
  });

  it('API error fails the check instead of reporting "no changes"', async () => {
    await assert.rejects(run(unchanged, { releases: lookups([['ToyStory2Recomp', { ok: false, reason: 'HTTP 503' }], ['romm2switch', okLookup(null)]]) }), /could not be determined.*HTTP 503/);
  });

  it('unreadable live manifest on an established site fails the check', async () => {
    await assert.rejects(run(unchanged, { manifest: { state: 'unreadable', reason: 'HTTP 500' } }), /Release check impossible/);
    await assert.rejects(run(unchanged, { manifest: { state: 'missing' } }), /Release check impossible/);
  });

  it('pre-manifest live site: release check is skipped (the merge itself triggers the first build)', async () => {
    const d = await decideWithReleases({ base: unchanged, liveInfo: infoPreManifest, loadManifest: async () => ({ state: 'missing' }), loadReleases: never });
    assert.equal(d.changed, false);
    assert.match(d.reason, /release check skipped \(first page manifest/);
  });

  it('a release-only build is deployable: the content gate is unaffected by releases', () => {
    // decideDeploy is still driven by code and Sanity only; the build/verify steps check commit + content hash.
    const fp = { version: 2, types: ['post', 'project'], count: 1, hash: 'h'.repeat(64) };
    const live: LiveBuildInfo = { state: 'found', info: { ...createBuildInfo(SHA, fp, new Date(0), MANIFEST_SCHEMA) } };
    assert.equal(decideDeploy({ current: fp, commit: SHA, live, force: null }).changed, false);
  });
});

// ── Workflow wiring ────────────────────────────────────────────────────────────────────────────────────────────

describe('deploy.yml: releases and page guard', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const section = (from: string, to?: string) => workflow.slice(workflow.indexOf(from), to ? workflow.indexOf(to) : undefined);

  it('gives the check step the read-only workflow token for the release lookups, with contents: read only', () => {
    const check = section('\n  check:', '\n  build:');
    assert.match(check, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.match(check, /permissions:\n\s+contents: read\n/);
    assert.doesNotMatch(check, /write/);
  });

  it('passes the built manifest from the build job into the deploy gate', () => {
    assert.match(section('\n  build:', '\n  deploy:'), /manifest: \$\{\{ steps\.built\.outputs\.manifest \}\}/);
    assert.match(section('\n  deploy:'), /BUILT_MANIFEST: \$\{\{ needs\.build\.outputs\.manifest \}\}/);
  });

  it('keeps the existing schedule and concurrency', () => {
    assert.match(workflow, /cron: '7,22,37,52 \* \* \* \*'/);
    assert.match(workflow, /cron: '17 3 \* \* \*'/);
    assert.match(workflow, /concurrency:\n\s+group: pages\n\s+cancel-in-progress: false/);
  });
});
