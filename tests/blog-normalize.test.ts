/**
 * Normalisation of CMS documents: validation, link sanitising and the content whitelist.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isExternalHref,
  isValidSlug,
  localImageResolver,
  normalizeBody,
  normalizePost,
  safeHref,
  type ImageResolver,
  type TextBlock,
} from '../src/lib/blog/normalize.ts';

const span = (text: string, marks: string[] = []) => ({ _type: 'span', _key: text, text, marks });
const block = (children: unknown[], extra: Record<string, unknown> = {}) => ({
  _type: 'block',
  _key: 'k',
  style: 'normal',
  markDefs: [],
  children,
  ...extra,
});

const base = {
  _id: 'p1',
  title: 'Hello',
  slug: { current: 'hello-world' },
  category: 'devlog',
  publishedAt: '2026-10-01T10:00:00Z',
  body: [block([span('Some words in the body.')])],
};

const fakeResolver: ImageResolver = (raw) =>
  typeof raw.asset?._id === 'string' ? { src: `https://cdn.sanity.io/images/x/y/${raw.asset._id}.png` } : null;

describe('safeHref', () => {
  it('allows http(s), mailto, site-relative paths and anchors', () => {
    assert.equal(safeHref('https://github.com/PeriBluGaming'), 'https://github.com/PeriBluGaming');
    assert.equal(safeHref('http://example.com'), 'http://example.com/');
    assert.equal(safeHref('mailto:hi@example.com'), 'mailto:hi@example.com');
    assert.equal(safeHref('/blog/x/'), '/blog/x/');
    assert.equal(safeHref('#section'), '#section');
  });

  it('rejects script URLs, protocol-relative URLs and garbage', () => {
    for (const href of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      '//evil.example',
      '/\\evil.example',
      'relative/path',
      '#',
      '',
      42,
      null,
    ]) {
      assert.equal(safeHref(href), null, String(href));
    }
  });

  it('marks only other hosts as external', () => {
    assert.equal(isExternalHref('https://github.com/x'), true);
    assert.equal(isExternalHref('https://periblugaming.github.io/blog/'), false);
    assert.equal(isExternalHref('/blog/'), false);
  });
});

describe('isValidSlug', () => {
  it('accepts lowercase kebab-case only', () => {
    assert.equal(isValidSlug('toy-story-2-widescreen'), true);
    for (const slug of ['Hello', 'a--b', '-a', 'a b', '../x', 'ä', '']) assert.equal(isValidSlug(slug), false, slug);
  });
});

describe('normalizeBody', () => {
  it('sanitises links and drops marks without a definition', () => {
    const [node] = normalizeBody(
      [
        block([span('a', ['ext', 'bad', 'strong', 'ghost', 'onclick'])], {
          markDefs: [
            { _key: 'ext', _type: 'link', href: 'https://github.com' },
            { _key: 'bad', _type: 'link', href: 'javascript:alert(1)' },
            { _key: 'evil', _type: 'script', src: 'x' },
          ],
        }),
      ],
      fakeResolver,
    ) as TextBlock[];
    assert.deepEqual(node.markDefs, [
      { _key: 'ext', _type: 'link', href: 'https://github.com/', external: true },
      { _key: 'bad', _type: 'link', href: null, external: false },
    ]);
    assert.deepEqual(node.children[0].marks, ['ext', 'bad', 'strong']);
  });

  it('turns internal references into /blog/<slug>/ links', () => {
    const [node] = normalizeBody(
      [block([span('a', ['i'])], { markDefs: [{ _key: 'i', _type: 'internalLink', slug: 'other-post' }] })],
      fakeResolver,
    ) as TextBlock[];
    assert.equal(node.markDefs[0].href, '/blog/other-post/');
  });

  it('whitelists block styles and drops unknown types', () => {
    const warnings: string[] = [];
    const nodes = normalizeBody(
      [
        block([span('h')], { style: 'h1' }),
        { _type: 'html', _key: 'x', html: '<script>alert(1)</script>' },
        { _type: 'codeBlock', _key: 'c', code: 'int x;\n', language: 'c"><script>' },
        { _type: 'image', _key: 'i' },
      ],
      fakeResolver,
      warnings,
    );
    assert.equal(nodes.length, 2);
    assert.equal((nodes[0] as TextBlock).style, 'normal');
    assert.deepEqual(nodes[1], { _type: 'codeBlock', _key: 'c', code: 'int x;' });
    assert.equal(warnings.length, 2);
  });
});

describe('normalizePost', () => {
  it('normalises a valid document with SEO fallbacks', () => {
    const result = normalizePost(base, fakeResolver);
    assert.ok(result.ok);
    const { post } = result;
    assert.equal(post.slug, 'hello-world');
    assert.equal(post.category.id, 'devlog');
    assert.equal(post.language, 'en');
    assert.equal(post.source, 'manual');
    assert.equal(post.excerpt, 'Some words in the body.');
    assert.deepEqual(post.seo, { title: 'Hello', description: 'Some words in the body.', noindex: false });
    assert.equal(post.readingMinutes, 1);
  });

  it('rejects documents without required fields', () => {
    for (const patch of [{ title: '' }, { slug: { current: 'Bad Slug' } }, { category: 'nope' }, { publishedAt: 'x' }]) {
      assert.equal(normalizePost({ ...base, ...patch }, fakeResolver).ok, false, JSON.stringify(patch));
    }
    assert.equal(normalizePost(null, fakeResolver).ok, false);
  });

  it('only links repositories and releases of PeriBluGaming', () => {
    const ok = normalizePost(
      { ...base, relatedRepo: 'ToyStory2Recomp', relatedRelease: { tag: 'v1.0', url: 'https://github.com/PeriBluGaming/ToyStory2Recomp/releases/tag/v1.0' } },
      fakeResolver,
    );
    assert.ok(ok.ok);
    assert.equal(ok.post.relatedRepo?.url, 'https://github.com/PeriBluGaming/ToyStory2Recomp');
    assert.equal(ok.post.relatedRelease?.tag, 'v1.0');

    const bad = normalizePost(
      { ...base, relatedRepo: '../../evil', relatedRelease: { tag: 'v1', url: 'https://evil.example/release' } },
      fakeResolver,
    );
    assert.ok(bad.ok);
    assert.equal(bad.post.relatedRepo, undefined);
    assert.equal(bad.post.relatedRelease, undefined);
    assert.equal(bad.warnings.length, 2);
  });

  it('keeps the release source flag and falls back to the default language', () => {
    const result = normalizePost({ ...base, source: 'github-release', language: 'xx' }, fakeResolver);
    assert.ok(result.ok);
    assert.equal(result.post.source, 'github-release');
    assert.equal(result.post.language, 'en');
  });
});

describe('localImageResolver', () => {
  it('only accepts image files below /images/', () => {
    assert.deepEqual(localImageResolver({ src: '/images/projects/a/b.png' }, []), { src: '/images/projects/a/b.png' });
    for (const src of ['https://evil.example/a.png', '/images/../secret.png', '/images/a.svg', '/other/a.png']) {
      assert.equal(localImageResolver({ src }, []), null, src);
    }
  });
});
