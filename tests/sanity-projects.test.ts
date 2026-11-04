/**
 * Sanity project documents: query, screenshot conversion (hotspot/crop → object-position), URL safety.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanityClientConfig } from '../src/lib/blog/sanity.ts';
import { PROJECTS_QUERY, hotspotPosition, sanityScreenshotResolver } from '../src/lib/sanity-projects.ts';

const config = { mode: 'sanity', projectId: 'abc123xy', dataset: 'production', apiVersion: '2025-02-19', allowFailure: false } as const;

describe('PROJECTS_QUERY', () => {
  it('reads published root documents only, in a stable order, with an explicit projection', () => {
    assert.match(PROJECTS_QUERY, /_type == "project" && _id in path\("\*"\)/);
    assert.match(PROJECTS_QUERY, /\| order\(_id asc\)/);
    assert.doesNotMatch(PROJECTS_QUERY, /\.\.\./); // no spread – only listed fields
    assert.match(PROJECTS_QUERY, /"screenshot": screenshots\[0\]/);
  });

  it('uses the blog client settings: published perspective, no CDN cache, no cookies', () => {
    const c = sanityClientConfig(config);
    assert.equal(c.perspective, 'published');
    assert.equal(c.useCdn, false);
    assert.equal(c.withCredentials, false);
  });
});

describe('hotspotPosition', () => {
  it('maps the hotspot to object-position, inside the cropped area', () => {
    assert.equal(hotspotPosition({ x: 0.3, y: 0.4 }, null), '30% 40%');
    assert.equal(hotspotPosition({ x: 0.5, y: 0.5 }, { left: 0.2, right: 0, top: 0, bottom: 0.5 }), '37.5% 100%');
    assert.equal(hotspotPosition({ x: 0.1, y: 0.9 }, { left: 0.2, right: 0.2, top: 0, bottom: 0 }), '0% 90%'); // clamped
  });

  it('falls back to center without a usable hotspot', () => {
    assert.equal(hotspotPosition(null, null), 'center');
    assert.equal(hotspotPosition({ x: Number.NaN, y: 0.5 }, null), 'center');
    assert.equal(hotspotPosition({ x: 0.5, y: 0.5 }, { left: 0.6, right: 0.6 }), 'center');
  });
});

describe('sanityScreenshotResolver', () => {
  const resolve = sanityScreenshotResolver(config);
  const shot = {
    alt: '  Buzz in Andy’s room ',
    hotspot: { x: 0.25, y: 0.75, width: 0.3, height: 0.3 },
    asset: { _id: 'image-abc123-1920x1080-png', metadata: { dimensions: { width: 1920, height: 1080 } } },
  };

  it('returns a cdn.sanity.io URL of this project, the alt text and the focal point', () => {
    const image = resolve(shot)!;
    assert.ok(image.src.startsWith('https://cdn.sanity.io/images/abc123xy/production/abc123-1920x1080.png?'));
    assert.match(image.src, /w=800/);
    assert.equal(image.alt, 'Buzz in Andy’s room');
    assert.equal(image.position, '25% 75%');
  });

  it('rejects screenshots without alt text, without a valid asset, or with foreign URLs', () => {
    assert.equal(resolve({ ...shot, alt: '  ' }), null);
    assert.equal(resolve({ ...shot, alt: undefined }), null);
    assert.equal(resolve({ ...shot, asset: { url: 'https://evil.example/x.png' } }), null);
    assert.equal(resolve({ ...shot, asset: { _id: 'file-abc-pdf' } }), null);
    assert.equal(resolve(null), null);
    assert.equal(resolve('x'), null);
  });
});
