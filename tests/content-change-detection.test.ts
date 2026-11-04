/**
 * Content-change detection for automatic deploys (posts + projects), end to end:
 * the real fingerprint query (src/lib/content-fingerprint.ts) is evaluated with groq-js against an in-memory dataset
 * that behaves like Sanity (publishing creates a new _rev, drafts live under drafts.*, release versions under
 * versions.<release>.*), and the result goes through the real deploy decision (src/lib/deploy-check.ts).
 *
 * groq-js comes with the Studio dependencies (`cd studio && npm ci`); without them these tests are reported as skipped.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { categories, defaultCategory, featuredProjects, listSettings, projectOverrides } from '../src/config/projects.ts';
import { loadBlog } from '../src/lib/blog/load.ts';
import { POSTS_QUERY } from '../src/lib/blog/sanity.ts';
import { buildContentFingerprint, computeFingerprint, fingerprintQuery, type ContentFingerprint } from '../src/lib/content-fingerprint.ts';
import { createBuildInfo, decideDeploy, fetchContentFingerprint, type BuildInfo } from '../src/lib/deploy-check.ts';
import type { RepoData } from '../src/lib/github.ts';
import { buildProjectData } from '../src/lib/project-data.ts';
import { validateProjectImage } from '../src/lib/project-image.ts';
import { PROJECT_DOCUMENT_FILTER } from '../src/lib/project-visibility.ts';
import { PROJECTS_QUERY, sanityScreenshotResolver } from '../src/lib/sanity-projects.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const studio = new URL('../studio/', import.meta.url);
const skip = existsSync(new URL('node_modules/groq-js/package.json', studio)) ? false : 'groq-js not installed (cd studio && npm ci)';

const NOW = new Date('2026-11-04T12:00:00Z');
const SHA = 'a'.repeat(40);
const sanityConfig = { mode: 'sanity', projectId: 'hyyn359x', dataset: 'production', apiVersion: '2025-02-19', allowFailure: false } as const;

type Doc = { _id: string; _type: string; _rev: string; [field: string]: unknown };
let revision = 0;
const nextRev = () => `rev${(++revision).toString(36)}`;

/** Minimal Sanity-like document store. */
class Dataset {
  docs = new Map<string, Doc>();
  clone(): Dataset {
    const copy = new Dataset();
    for (const [id, d] of this.docs) copy.docs.set(id, structuredClone(d));
    return copy;
  }
  /** Publish (create or edit): replaces the published document, removes the draft, new revision. */
  publish(id: string, type: string, fields: Record<string, unknown>): this {
    const base = this.docs.get(`drafts.${id}`) ?? this.docs.get(id) ?? {};
    this.docs.set(id, { ...base, ...fields, _id: id, _type: type, _rev: nextRev() });
    this.docs.delete(`drafts.${id}`);
    return this;
  }
  /** Remove fields from the published document (e.g. unset `featured`) and publish. */
  unsetAndPublish(id: string, ...fields: string[]): this {
    const doc = { ...this.docs.get(id)! };
    for (const f of fields) delete doc[f];
    this.docs.set(id, { ...doc, _rev: nextRev() });
    return this;
  }
  saveDraft(id: string, fields: Record<string, unknown>): this {
    const base = this.docs.get(`drafts.${id}`) ?? this.docs.get(id)!;
    this.docs.set(`drafts.${id}`, { ...base, ...fields, _id: `drafts.${id}`, _rev: nextRev() });
    return this;
  }
  stageInRelease(release: string, id: string, fields: Record<string, unknown>): this {
    const base = this.docs.get(id)!;
    this.docs.set(`versions.${release}.${id}`, { ...base, ...fields, _id: `versions.${release}.${id}`, _rev: nextRev() });
    return this;
  }
  /** Unpublish keeps the content as a draft; delete removes everything. */
  unpublish(id: string): this {
    const doc = this.docs.get(id)!;
    this.docs.delete(id);
    this.docs.set(`drafts.${id}`, { ...doc, _id: `drafts.${id}`, _rev: nextRev() });
    return this;
  }
  delete(id: string): this {
    this.docs.delete(id);
    this.docs.delete(`drafts.${id}`);
    return this;
  }
  list(order: 'asc' | 'reverse' = 'asc'): Doc[] {
    const docs = [...this.docs.values()];
    return order === 'reverse' ? docs.reverse() : docs;
  }
}

const image = (ref: string, extra: Record<string, unknown> = {}) => ({
  _key: 'shot1',
  _type: 'image',
  alt: 'Buzz Lightyear exploring Andy’s room in widescreen.',
  asset: { _type: 'reference', _ref: ref },
  hotspot: { x: 0.5, y: 0.4, width: 0.3, height: 0.3 },
  crop: { top: 0, bottom: 0, left: 0, right: 0 },
  ...extra,
});

/** Realistic starting point: published, hidden and scheduled posts; three project documents; one asset. */
function production(): Dataset {
  return new Dataset()
    .publish('image-abc123-1920x1080-png', 'sanity.imageAsset', { url: 'https://cdn.sanity.io/images/hyyn359x/production/abc123-1920x1080.png', metadata: { dimensions: { width: 1920, height: 1080 } } })
    .publish('post-hello', 'post', { title: 'Hello', slug: { current: 'hello' }, excerpt: 'First post.', category: 'devlog', publishedAt: '2026-11-01T10:00:00Z', body: [] })
    .publish('post-hidden', 'post', { title: 'Hidden', slug: { current: 'hidden' }, excerpt: 'x', category: 'news', publishedAt: '2026-10-01T10:00:00Z', hidden: true, body: [] })
    .publish('post-later', 'post', { title: 'Later', slug: { current: 'later' }, excerpt: 'x', category: 'news', publishedAt: '2026-12-01T10:00:00Z', body: [] })
    .publish('project-ts2', 'project', {
      repo: 'ToyStory2Recomp', title: 'Toy Story 2 Recomp', featured: true, featuredOrder: 0, accent: 'cyan', category: 'playstation',
      tags: ['PS1', 'Recomp'], hidden: false, screenshots: [image('image-abc123-1920x1080-png')],
    })
    .publish('project-romm', 'project', { repo: 'romm2switch', featured: false, hidden: false })
    .publish('project-ui', 'project', { repo: 'recomp-ui', hidden: true });
}

describe('content-change detection (Sanity-like dataset, real queries)', { skip }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let groq: any;

  before(async () => {
    const entry = createRequire(new URL('package.json', studio)).resolve('groq-js');
    groq = await import(pathToFileURL(entry).href);
  });

  const run = async (query: string, docs: Doc[], now = NOW) =>
    (await groq.evaluate(groq.parse(query), { dataset: docs, timestamp: now })).get();

  /** What the scheduled check computes (tokenless API, same query). */
  const checkFingerprint = async (ds: Dataset, now = NOW, order: 'asc' | 'reverse' = 'asc') =>
    computeFingerprint(await run(fingerprintQuery(), ds.list(order), now));

  const live = (content: ContentFingerprint | null): { state: 'found'; info: BuildInfo } => ({ state: 'found', info: createBuildInfo(SHA, content) });

  /** Deploy decision of the 15-minute check: live site built from `before`, Sanity now holds `after`. */
  async function decision(before: Dataset, after: Dataset, now = NOW) {
    return decideDeploy({ current: await checkFingerprint(after, now), commit: SHA, live: live(await checkFingerprint(before)), force: null });
  }
  const changed = async (edit: (ds: Dataset) => unknown) => {
    const before = production();
    const after = before.clone();
    edit(after);
    return (await decision(before, after)).changed;
  };

  describe('the fingerprint query selects exactly the documents that can affect the site', () => {
    it('published projects (incl. hidden ones) and visible posts; no drafts, releases, scheduled or hidden posts', async () => {
      const ds = production().saveDraft('project-ts2', { title: 'Draft' }).stageInRelease('rSpring', 'post-hello', { title: 'Next' });
      const ids = ((await run(fingerprintQuery(), ds.list())) as Doc[]).map((d) => d._id).sort();
      assert.deepEqual(ids, ['post-hello', 'project-romm', 'project-ts2', 'project-ui']);
    });

    it('uses the same project filter as the website query', () => {
      assert.ok(PROJECTS_QUERY.includes(PROJECT_DOCUMENT_FILTER));
      assert.ok(fingerprintQuery().includes(PROJECT_DOCUMENT_FILTER));
    });
  });

  describe('deploy decision', () => {
    it('no changes → no rebuild', async () => {
      const ds = production();
      assert.deepEqual(await decision(ds, ds.clone()), { changed: false, reason: 'no changes since the live build' });
    });

    it('blog-only change → rebuild', async () => {
      assert.equal(await changed((ds) => ds.publish('post-hello', 'post', { excerpt: 'Edited.' })), true);
    });

    it('project-only change → rebuild', async () => {
      const result = await (async () => {
        const before = production();
        return decision(before, before.clone().publish('project-romm', 'project', { title: 'RomM2Switch' }));
      })();
      assert.equal(result.changed, true);
      assert.match(result.reason, /content changed \(4 → 4 visible documents\)/);
    });

    it('combined blog and project change → rebuild', async () => {
      assert.equal(await changed((ds) => ds.publish('post-hello', 'post', { title: 'Hi' }).publish('project-ts2', 'project', { title: 'TS2' })), true);
    });

    it('adding or removing a published project → rebuild', async () => {
      assert.equal(await changed((ds) => ds.publish('project-new', 'project', { repo: 'RescueShotRecomp', featured: true })), true);
      assert.equal(await changed((ds) => ds.delete('project-romm')), true);
      assert.equal(await changed((ds) => ds.unpublish('project-romm')), true);
    });

    const edits: [string, (ds: Dataset) => unknown][] = [
      ['title', (ds) => ds.publish('project-ts2', 'project', { title: 'Toy Story 2' })],
      ['description', (ds) => ds.publish('project-ts2', 'project', { description: 'New copy.' })],
      ['featured true → false', (ds) => ds.publish('project-ts2', 'project', { featured: false })],
      ['featured false → true', (ds) => ds.publish('project-romm', 'project', { featured: true })],
      ['featured unset', (ds) => ds.unsetAndPublish('project-romm', 'featured')],
      ['featuredOrder', (ds) => ds.publish('project-ts2', 'project', { featuredOrder: 3 })],
      ['hidden', (ds) => ds.publish('project-ui', 'project', { hidden: false })],
      ['category', (ds) => ds.publish('project-ts2', 'project', { category: 'tools' })],
      ['tags', (ds) => ds.publish('project-ts2', 'project', { tags: ['PS1'] })],
      ['accent', (ds) => ds.publish('project-ts2', 'project', { accent: 'pink' })],
      ['screenshot replaced', (ds) => ds.publish('project-ts2', 'project', { screenshots: [image('image-def456-1280x720-webp')] })],
      ['screenshot alt text', (ds) => ds.publish('project-ts2', 'project', { screenshots: [image('image-abc123-1920x1080-png', { alt: 'Title screen.' })] })],
      ['screenshot hotspot', (ds) => ds.publish('project-ts2', 'project', { screenshots: [image('image-abc123-1920x1080-png', { hotspot: { x: 0.2, y: 0.8, width: 0.3, height: 0.3 } })] })],
      ['screenshot crop', (ds) => ds.publish('project-ts2', 'project', { screenshots: [image('image-abc123-1920x1080-png', { crop: { top: 0.1, bottom: 0, left: 0, right: 0.2 } })] })],
    ];
    for (const [label, edit] of edits) {
      it(`published project edit: ${label} → rebuild`, async () => {
        assert.equal(await changed(edit), true);
      });
    }

    it('draft-only changes (posts and projects) → no rebuild', async () => {
      assert.equal(await changed((ds) => ds.saveDraft('project-ts2', { title: 'WIP', featured: false }).saveDraft('post-hello', { title: 'WIP' })), false);
      assert.equal(await changed((ds) => ds.saveDraft('project-romm', { hidden: true })), false);
    });

    it('release-version-only changes → no rebuild', async () => {
      assert.equal(await changed((ds) => ds.stageInRelease('rLaunch', 'project-ts2', { featured: false }).stageInRelease('rLaunch', 'post-hello', { title: 'x' })), false);
    });

    it('a scheduled post becoming visible → rebuild, without any new revision', async () => {
      const ds = production();
      const later = new Date('2026-12-02T00:00:00Z');
      assert.equal((await decideDeploy({ current: await checkFingerprint(ds, later), commit: SHA, live: live(await checkFingerprint(ds)), force: null })).changed, true);
    });

    it('is independent of the API response order', async () => {
      const ds = production();
      assert.equal((await checkFingerprint(ds, NOW, 'asc')).hash, (await checkFingerprint(ds, NOW, 'reverse')).hash);
    });

    it('an empty project collection is a valid state (no error), different from one with projects', async () => {
      const noProjects = production().delete('project-ts2').delete('project-romm').delete('project-ui');
      const fp = await checkFingerprint(noProjects);
      assert.equal(fp.count, 1);
      assert.notEqual(fp.hash, (await checkFingerprint(production())).hash);
      assert.equal((await checkFingerprint(new Dataset())).count, 0);
    });
  });

  describe('build and check agree', () => {
    it('the build fingerprints exactly what the check computes – real post and project queries', async () => {
      const ds = production().saveDraft('project-ts2', { title: 'Draft' }).stageInRelease('r1', 'project-romm', { featured: true });
      const silent = { info() {}, warn() {} };
      const blog = await loadBlog(sanityConfig, {
        fetchSanity: async () => run(POSTS_QUERY, ds.list()),
        sanityImageResolver: () => () => null,
        samplePosts: async () => [],
        now: () => NOW,
        log: silent,
      });
      const fallback = JSON.parse(readFileSync(join(root, 'src/data/fallback-repos.json'), 'utf8')) as { fetchedAt: string; repos: RepoData[] };
      const projects = await buildProjectData({
        env: {},
        config: { categories, defaultCategory, projectOverrides, featuredProjects, listSettings },
        githubUser: 'PeriBluGaming',
        fallback,
        fetchRepos: async () => fallback.repos,
        sanityConfig,
        fetchSanityProjects: async () => run(PROJECTS_QUERY, ds.list()),
        screenshotResolver: sanityScreenshotResolver,
        resolveLocalImage: (img, repo) => validateProjectImage(img, repo, join(root, 'public')),
        log: silent,
      });
      const built = buildContentFingerprint({ blog, projects });
      assert.ok(built.content);
      assert.deepEqual(built.content, await checkFingerprint(ds));
      // …and the build really used the published project data
      assert.equal(projects.featured[0].title, 'Toy Story 2 Recomp');
      assert.ok(projects.featured[0].image?.src.startsWith('https://cdn.sanity.io/images/hyyn359x/production/abc123-1920x1080.png'));
      assert.ok(!projects.all.some((p) => p.name === 'recomp-ui')); // hidden
    });
  });
});

describe('failure handling', () => {
  it('a failed or disabled project fetch yields no fingerprint (never an "empty" one)', () => {
    const blog = { status: 'sanity', contentItems: [{ _type: 'post', _id: 'p', _rev: 'r' }] };
    for (const overrides of ['unavailable', 'disabled']) {
      const result = buildContentFingerprint({ blog, projects: { overrides } });
      assert.equal(result.content, null);
      assert.match(result.reason!, /project documents not loaded from Sanity/);
    }
    assert.equal(buildContentFingerprint({ blog: { status: 'unavailable' }, projects: { overrides: 'sanity', contentItems: [] } }).content, null);
    assert.equal(buildContentFingerprint({ blog, projects: { overrides: 'sanity', contentItems: [] } }).content?.count, 1); // valid empty collection
  });

  it('the scheduled check fails on a Sanity API error instead of reporting a deletion', async () => {
    const failing = async () => new Response('{}', { status: 503 });
    await assert.rejects(
      fetchContentFingerprint({ SANITY_PROJECT_ID: 'hyyn359x', SANITY_DATASET: 'production' }, { fetchImpl: failing, delayMs: 0 }),
      /Sanity query failed after 3 attempts/,
    );
  });

  it('the check queries posts and projects in one tokenless request', async () => {
    let query = '';
    await fetchContentFingerprint(
      { SANITY_PROJECT_ID: 'hyyn359x', SANITY_DATASET: 'production', SANITY_READ_TOKEN: 'sk-secret' },
      {
        fetchImpl: async (url, init) => {
          query = new URL(String(url)).searchParams.get('query') ?? '';
          assert.doesNotMatch(JSON.stringify(init?.headers ?? {}), /sk-secret|Authorization/i);
          return new Response(JSON.stringify({ result: [] }), { status: 200 });
        },
      },
    );
    assert.ok(query.includes('_type == "post"') && query.includes(PROJECT_DOCUMENT_FILTER));
  });
});

describe('fingerprint version migration', () => {
  it('a live build from the posts-only version (1) triggers exactly one rebuild', () => {
    const current = computeFingerprint([{ _type: 'post', _id: 'post-hello', _rev: 'r1' }]);
    const v1 = { version: 1, types: ['post'], count: 1, hash: 'f'.repeat(64) };
    const before = decideDeploy({ current, commit: SHA, live: { state: 'found', info: createBuildInfo(SHA, v1) }, force: null });
    assert.deepEqual(before, { changed: true, reason: 'live build info has an older format or no content fingerprint' });
    const after = decideDeploy({ current, commit: SHA, live: { state: 'found', info: createBuildInfo(SHA, current) }, force: null });
    assert.equal(after.changed, false);
    assert.deepEqual(current.types, ['post', 'project']);
    assert.equal(current.version, 2);
  });
});
