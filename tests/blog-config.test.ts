/**
 * Build-time blog configuration: which data source is used and when the build must refuse to start.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BlogConfigError, DEFAULT_API_VERSION, readBlogConfig } from '../src/lib/blog/config.ts';

describe('readBlogConfig', () => {
  it('is disabled without SANITY_PROJECT_ID (deliberately not configured, not an error)', () => {
    assert.deepEqual(readBlogConfig({}), { mode: 'disabled' });
    assert.deepEqual(readBlogConfig({ SANITY_PROJECT_ID: '  ', SANITY_DATASET: 'production' }), { mode: 'disabled' });
  });

  it('uses Sanity with defaults when a project ID is set', () => {
    assert.deepEqual(readBlogConfig({ SANITY_PROJECT_ID: 'abc123xy' }), {
      mode: 'sanity',
      projectId: 'abc123xy',
      dataset: 'production',
      apiVersion: DEFAULT_API_VERSION,
      allowFailure: false,
    });
  });

  it('passes an optional read token and the allow-failure flag', () => {
    const config = readBlogConfig({
      SANITY_PROJECT_ID: 'abc123xy',
      SANITY_DATASET: 'staging',
      SANITY_READ_TOKEN: 'sk-secret',
      SANITY_ALLOW_FAILURE: '1',
    });
    assert.equal(config.mode, 'sanity');
    assert.equal(config.mode === 'sanity' && config.token, 'sk-secret');
    assert.equal(config.mode === 'sanity' && config.allowFailure, true);
    assert.equal(config.mode === 'sanity' && config.dataset, 'staging');
  });

  it('rejects malformed values instead of building against the wrong project', () => {
    assert.throws(() => readBlogConfig({ SANITY_PROJECT_ID: 'ABC 123' }), BlogConfigError);
    assert.throws(() => readBlogConfig({ SANITY_PROJECT_ID: 'abc', SANITY_DATASET: '../x' }), BlogConfigError);
    assert.throws(() => readBlogConfig({ SANITY_PROJECT_ID: 'abc', SANITY_API_VERSION: 'latest' }), BlogConfigError);
  });

  it('uses sample posts with BLOG_SAMPLE=1, even if Sanity is configured', () => {
    assert.deepEqual(readBlogConfig({ BLOG_SAMPLE: '1', SANITY_PROJECT_ID: 'abc' }), { mode: 'sample' });
  });

  it('refuses sample posts in CI so they can never be deployed', () => {
    assert.throws(() => readBlogConfig({ BLOG_SAMPLE: '1', GITHUB_ACTIONS: 'true' }), BlogConfigError);
    assert.throws(() => readBlogConfig({ BLOG_SAMPLE: '1', CI: 'true' }), BlogConfigError);
  });
});
