/**
 * Validation rules for featured project screenshots.
 * Run with `npm test` (Node's built-in test runner, no extra dependencies).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ProjectImageError, validateProjectImage } from '../src/lib/project-image.ts';

const publicDir = mkdtempSync(join(tmpdir(), 'pbg-public-'));
mkdirSync(join(publicDir, 'images/projects/demo'), { recursive: true });
writeFileSync(join(publicDir, 'images/projects/demo/shot.webp'), 'fixture');
mkdirSync(join(publicDir, 'images/projects/folder.webp'));
after(() => rmSync(publicDir, { recursive: true, force: true }));

const valid = { src: '/images/projects/demo/shot.webp', alt: 'Demo screenshot' };
const check = (image: Partial<typeof valid> & { position?: string }) =>
  validateProjectImage({ ...valid, ...image }, 'Demo', publicDir);

describe('validateProjectImage', () => {
  it('accepts an existing local file and defaults the position to center', () => {
    assert.deepEqual(check({}), { ...valid, position: 'center' });
  });

  it('trims values and keeps a custom position', () => {
    assert.deepEqual(check({ alt: '  Demo screenshot ', position: ' 50% 30% ' }), { ...valid, position: '50% 30%' });
  });

  it('rejects missing files and directories', () => {
    assert.throws(() => check({ src: '/images/projects/demo/missing.webp' }), ProjectImageError);
    assert.throws(() => check({ src: '/images/projects/folder.webp' }), ProjectImageError);
  });

  it('rejects remote URLs and paths outside /images/projects/', () => {
    for (const src of [
      'https://example.com/shot.webp',
      '//example.com/shot.webp',
      '/images/logo-wordmark.webp',
      '/images/projects/../logo-wordmark.webp',
      '/images/projects/demo/shot.webp?v=1',
    ]) {
      assert.throws(() => check({ src }), ProjectImageError, src);
    }
  });

  it('rejects unsupported file types', () => {
    assert.throws(() => check({ src: '/images/projects/demo/shot.gif' }), ProjectImageError);
  });

  it('requires a non-empty alt text', () => {
    assert.throws(() => check({ alt: '   ' }), ProjectImageError);
  });

  it('rejects position values that could break out of the style attribute', () => {
    assert.throws(() => check({ position: 'center; background: red' }), ProjectImageError);
    assert.throws(() => check({ position: 'url(x)' }), ProjectImageError);
  });
});
