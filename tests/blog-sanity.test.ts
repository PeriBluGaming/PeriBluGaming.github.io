/**
 * The Sanity client must only ever read published content.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { POSTS_QUERY, sanityClientConfig, sanityImageResolver } from '../src/lib/blog/sanity.ts';

const config = { mode: 'sanity', projectId: 'abc123xy', dataset: 'production', apiVersion: '2025-02-19', allowFailure: false } as const;

describe('sanity client', () => {
  it('reads only the published perspective, uncached, without cookies or stega', () => {
    const c = sanityClientConfig(config);
    assert.equal(c.perspective, 'published');
    assert.equal(c.useCdn, false);
    assert.equal(c.withCredentials, false);
    assert.equal(c.stega, false);
    assert.equal('token' in c, false);
  });

  it('passes a read token only when configured', () => {
    assert.equal(sanityClientConfig({ ...config, token: 'sk-x' }).token, 'sk-x');
  });

  it('restricts the query to root-path documents (no drafts.*, versions.*) and published dates', () => {
    assert.match(POSTS_QUERY, /_id in path\("\*"\)/);
    assert.match(POSTS_QUERY, /publishedAt <= now\(\)/);
    assert.match(POSTS_QUERY, /hidden != true/);
  });
});

describe('sanityImageResolver', () => {
  const resolve = sanityImageResolver(config);

  it('builds cdn.sanity.io URLs with a srcset and cropped dimensions', () => {
    const img = resolve(
      { asset: { _id: 'image-abc123-2000x1000-png', metadata: { dimensions: { width: 2000, height: 1000 } } }, crop: { left: 0.25, right: 0.25, top: 0, bottom: 0 } },
      [480, 800],
    );
    assert.ok(img?.src.startsWith('https://cdn.sanity.io/images/abc123xy/production/'));
    assert.match(img!.srcset!, / 480w, .* 800w$/);
    assert.equal(img!.width, 1000);
    assert.equal(img!.height, 1000);
  });

  it('ignores images without a valid asset id', () => {
    assert.equal(resolve({ asset: { url: 'https://evil.example/x.png' } }, [480]), null);
    assert.equal(resolve({ src: '/images/x.png' }, [480]), null);
  });
});
