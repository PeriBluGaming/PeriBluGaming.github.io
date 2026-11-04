/**
 * Loading posts: distinguishes "not configured" from "Sanity failed", and never fails silently.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { BlogConfig } from '../src/lib/blog/config.ts';
import { BlogSourceError, isBlogVisible, loadBlog, processPosts, type BlogSources } from '../src/lib/blog/load.ts';
import { localImageResolver } from '../src/lib/blog/normalize.ts';

const sanity: BlogConfig = { mode: 'sanity', projectId: 'abc', dataset: 'production', apiVersion: '2025-02-19', allowFailure: false };
const silent = { info() {}, warn() {} };
const now = () => new Date('2026-11-01T00:00:00Z');

const doc = (id: string, slug: string, publishedAt: string, category = 'news') => ({
  _id: id,
  title: id,
  slug: { current: slug },
  category,
  publishedAt,
  body: [],
  excerpt: 'x',
});

const sources = (fetchSanity: BlogSources['fetchSanity']): BlogSources => ({
  fetchSanity,
  sanityImageResolver: () => () => null,
  samplePosts: async () => JSON.parse(readFileSync(new URL('../src/data/sample-posts.json', import.meta.url), 'utf8')),
  now,
  log: silent,
});

const unreachable = sources(async () => {
  throw new Error('getaddrinfo ENOTFOUND abc.api.sanity.io');
});

describe('loadBlog', () => {
  it('returns no posts and stays hidden when Sanity is not configured', async () => {
    let called = false;
    const data = await loadBlog({ mode: 'disabled' }, sources(async () => ((called = true), [])));
    assert.equal(data.status, 'disabled');
    assert.deepEqual(data.posts, []);
    assert.equal(called, false);
    assert.equal(isBlogVisible(data), false);
  });

  it('FAILS the build when a configured Sanity is unreachable', async () => {
    await assert.rejects(() => loadBlog(sanity, unreachable), (err: Error) => {
      assert.ok(err instanceof BlogSourceError);
      assert.match(err.message, /ENOTFOUND/);
      assert.match(err.message, /SANITY_ALLOW_FAILURE/);
      return true;
    });
  });

  it('fails on an unexpected response shape', async () => {
    await assert.rejects(() => loadBlog(sanity, sources(async () => ({ error: 'x' }))), BlogSourceError);
  });

  it('builds without posts only when SANITY_ALLOW_FAILURE is set, and reports it', async () => {
    const data = await loadBlog({ ...sanity, allowFailure: true }, unreachable);
    assert.equal(data.status, 'unavailable');
    assert.deepEqual(data.posts, []);
    assert.equal(data.warnings.length, 1);
    assert.equal(isBlogVisible(data), false);
  });

  it('loads Sanity posts newest first with their categories', async () => {
    const data = await loadBlog(
      sanity,
      sources(async () => [doc('a', 'old', '2026-01-01T00:00:00Z'), doc('b', 'new', '2026-06-01T00:00:00Z', 'devlog')]),
    );
    assert.equal(data.status, 'sanity');
    assert.deepEqual(data.posts.map((p) => p.slug), ['new', 'old']);
    assert.deepEqual(data.categories.map((c) => c.id), ['devlog', 'news']);
    assert.equal(isBlogVisible(data), true);
  });

  it('records type, id and revision of every fetched document for the deploy fingerprint', async () => {
    const data = await loadBlog(
      sanity,
      sources(async () => [
        { ...doc('a', 'ok', '2026-01-01T00:00:00Z'), _type: 'post', _rev: 'r1' },
        { _type: 'post', _id: 'broken', _rev: 'r2' }, // skipped for rendering, still part of the fetched state
      ]),
    );
    assert.deepEqual(data.contentItems, [
      { _type: 'post', _id: 'a', _rev: 'r1' },
      { _type: 'post', _id: 'broken', _rev: 'r2' },
    ]);
    assert.equal(data.posts.length, 1);
    assert.equal((await loadBlog({ mode: 'disabled' }, sources(async () => []))).contentItems, undefined);
  });

  it('leaves posts the build treats as scheduled out of the fingerprint (clock skew to Sanity)', async () => {
    // Sanity's clock already returned it, ours (now = 2026-11-01T00:00Z) is a second behind.
    const data = await loadBlog(
      sanity,
      sources(async () => [
        { ...doc('live', 'live', '2026-01-01T00:00:00Z'), _type: 'post', _rev: 'r1' },
        { ...doc('soon', 'soon', '2026-11-01T00:00:01Z'), _type: 'post', _rev: 'r1' },
      ]),
    );
    assert.deepEqual(data.posts.map((p) => p.slug), ['live']);
    assert.deepEqual(data.contentItems?.map((i) => i._id), ['live']); // next check sees "soon" → rebuild
  });

  it('keeps the blog hidden when Sanity is configured but has no posts yet', async () => {
    const data = await loadBlog(sanity, sources(async () => []));
    assert.equal(data.status, 'sanity');
    assert.equal(isBlogVisible(data), false);
  });

  it('loads the sample posts in sample mode', async () => {
    const data = await loadBlog({ mode: 'sample' }, unreachable);
    assert.equal(data.status, 'sample');
    assert.ok(data.posts.length >= 4);
    assert.deepEqual(data.warnings, []);
    assert.ok(data.posts.every((p) => !p.cover || p.cover.src.startsWith('/images/')));
  });
});

describe('processPosts', () => {
  it('skips broken documents, duplicate slugs and scheduled posts instead of failing', () => {
    const { posts, warnings } = processPosts(
      [
        doc('a', 'same', '2026-02-01T00:00:00Z'),
        doc('b', 'same', '2026-03-01T00:00:00Z'),
        doc('c', 'future', '2027-01-01T00:00:00Z'),
        { _id: 'broken' },
      ],
      localImageResolver,
      now(),
    );
    assert.deepEqual(posts.map((p) => p.id), ['a']);
    assert.equal(warnings.length, 2);
  });
});

describe('internal links', () => {
  it('turns links to hidden or scheduled posts into plain text', () => {
    const linking = {
      ...doc('a', 'a', '2026-02-01T00:00:00Z'),
      body: [
        {
          _type: 'block',
          _key: 'b',
          markDefs: [
            { _key: 'ok', _type: 'internalLink', slug: 'b' },
            { _key: 'gone', _type: 'internalLink', slug: 'future' },
          ],
          children: [{ _type: 'span', _key: 's', text: 'x', marks: ['ok', 'gone'] }],
        },
      ],
    };
    const { posts, warnings } = processPosts(
      [linking, doc('b', 'b', '2026-01-01T00:00:00Z'), doc('c', 'future', '2027-01-01T00:00:00Z')],
      localImageResolver,
      now(),
    );
    const block = posts.find((p) => p.slug === 'a')!.body[0];
    assert.equal(block._type, 'block');
    assert.deepEqual(block._type === 'block' && block.markDefs.map((d) => d.href), ['/blog/b/', null]);
    assert.equal(warnings.length, 1);
  });
});
