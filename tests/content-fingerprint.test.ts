/**
 * The deploy fingerprint must change exactly when visible content changes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { POST_VISIBLE_FILTER } from '../src/lib/blog/visibility.ts';
import { POSTS_QUERY } from '../src/lib/blog/sanity.ts';
import {
  FingerprintError,
  computeFingerprint,
  contentSources,
  fingerprintQuery,
  type ContentSource,
} from '../src/lib/content-fingerprint.ts';

const post = (id: string, rev: string) => ({ _type: 'post', _id: id, _rev: rev });
const a = post('a', 'r1');
const b = post('b', 'r1');

describe('fingerprint query', () => {
  it('uses the same visibility rules as the blog query', () => {
    assert.ok(POSTS_QUERY.includes(POST_VISIBLE_FILTER));
    assert.ok(fingerprintQuery().includes(POST_VISIBLE_FILTER));
    assert.match(POSTS_QUERY, /_rev/);
  });

  it('excludes drafts and versions and only selects type, id and revision', () => {
    const q = fingerprintQuery();
    assert.match(q, /_id in path\("\*"\)/);
    assert.match(q, /\{_type, _id, _rev\}$/);
  });

  it('combines several sources in one query (posts and projects; extensible)', () => {
    assert.match(fingerprintQuery(), /\) \|\| \(_type == "project" && _id in path\("\*"\)\)/);
    const sources: ContentSource[] = [...contentSources, { type: 'game', filter: '_type == "game"' }];
    assert.match(fingerprintQuery(sources), /\) \|\| \(_type == "game"\)/);
  });
});

describe('computeFingerprint', () => {
  it('is independent of the order of documents', () => {
    assert.equal(computeFingerprint([a, b]).hash, computeFingerprint([b, a]).hash);
  });

  it('changes when a document is published, edited or removed', () => {
    const base = computeFingerprint([a]).hash;
    assert.notEqual(computeFingerprint([a, b]).hash, base); // published / scheduled post became visible
    assert.notEqual(computeFingerprint([post('a', 'r2')]).hash, base); // edited and re-published
    assert.notEqual(computeFingerprint([]).hash, base); // unpublished, deleted or hidden
  });

  it('reports version, types and count', () => {
    const fp = computeFingerprint([a, b]);
    assert.deepEqual({ ...fp, hash: fp.hash.length }, { version: 2, types: ['post', 'project'], count: 2, hash: 64 });
  });

  it('separates types with the same id', () => {
    const asPost = computeFingerprint([a]).hash;
    const asProject = computeFingerprint([{ ...a, _type: 'project' }]).hash;
    assert.notEqual(asPost, asProject);
  });

  it('rejects malformed input instead of producing a misleading fingerprint', () => {
    assert.throws(() => computeFingerprint(null), FingerprintError);
    assert.throws(() => computeFingerprint([{ _type: 'post', _id: 'a' }]), FingerprintError);
    assert.throws(() => computeFingerprint([{ ...a, _rev: '' }]), FingerprintError);
    assert.throws(() => computeFingerprint([{ ...a, _type: 'game' }]), FingerprintError); // not a configured source
    assert.throws(() => computeFingerprint([a, post('a', 'r2')]), FingerprintError); // duplicate id
  });
});
