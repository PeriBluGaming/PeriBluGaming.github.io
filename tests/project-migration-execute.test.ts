/**
 * Controlled Sanity project migration: authenticated preflight, execution gates, conditional transactions.
 * Runs entirely against an in-memory Sanity adapter (and a fetch stub for the HTTP adapter) – never production.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as projectConfig from '../src/config/projects.ts';
import type { RepoData } from '../src/lib/github.ts';
import { validateProjectImage } from '../src/lib/project-image.ts';
import { planFingerprint } from '../src/lib/project-migration.ts';
import {
  MIGRATION_READ_TOKEN_ENV,
  MIGRATION_WRITE_TOKEN_ENV,
  authenticatedPreflight,
  buildTransaction,
  executeMigration,
  migrationTransactionId,
  parseExecuteArgs,
  type PreflightContext,
} from '../src/lib/project-migration-execute.ts';
import {
  MAX_TRANSACTION_ID_LENGTH,
  MigrationCommitError,
  assertSafeTransaction,
  createHttpAdapter,
  type ApprovedTargets,
  type MigrationTransaction,
  type RawSanityDoc,
  type SanityMigrationAdapter,
} from '../src/lib/sanity-migration-adapter.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const { categories, defaultCategory, featuredProjects, listSettings, projectOverrides } = projectConfig;
const fallback = JSON.parse(readFileSync(join(root, 'src/data/fallback-repos.json'), 'utf8')) as { fetchedAt: string; repos: RepoData[] };
const repo = (name: string): RepoData => ({ name, url: `https://github.com/PeriBluGaming/${name}`, description: null, language: 'C', stars: 0, fork: false, archived: false, pushedAt: '2026-11-03T16:10:16Z', topics: [] });
const inventory = [...fallback.repos, repo('SledStormPSXRecomp'), repo('PeriBluGaming.github.io')];
const READ_TOKEN = 'skTESTreadToken0123456789abcdef';
const WRITE_TOKEN = 'skTESTwriteToken9876543210fedcba';
const env = { SANITY_PROJECT_ID: 'hyyn359x', SANITY_DATASET: 'production', [MIGRATION_READ_TOKEN_ENV]: READ_TOKEN, [MIGRATION_WRITE_TOKEN_ENV]: WRITE_TOKEN };
const ALL_IDS = ['project-bugsbunnylostintimerecomp', 'project-psxrecomp', 'project-recomp-ui', 'project-rescueshotrecomp', 'project-romm2switch', 'project-sledstormpsxrecomp', 'project-supermarioworld2yoshisislandrecomp', 'project-toystory2recomp'];
const INTENDED = ['ToyStory2Recomp', 'BugsBunnyLostinTimeRecomp', 'RescueShotRecomp', 'SledStormPSXRecomp', 'SuperMarioWorld2YoshisIslandRecomp', 'romm2switch'];

/**
 * In-memory Sanity: raw perspective, atomic transactions, create-if-absent, revision-checked patches.
 * Like GROQ, listProjectDocuments() cannot show an explicit null (null fields are dropped); getDocuments() returns
 * the exact stored documents like the doc endpoint.
 */
class MemorySanity implements SanityMigrationAdapter {
  docs = new Map<string, RawSanityDoc>();
  assets: { _id: string; sha1hash: string }[] = [];
  commits: MigrationTransaction[] = [];
  transactionIds = new Set<string>();
  reads = 0;
  onRead?: (n: number) => void;
  beforeCommit?: () => void;
  fail?: 'reject' | 'unknown-before' | 'unknown-after' | 'read' | 'read-after-commit';
  private revCounter = 0;
  rev() {
    return `rev${++this.revCounter}`;
  }
  put(doc: { _id: string; _type: string; _rev?: string; [field: string]: unknown }) {
    this.docs.set(doc._id, { ...doc, _rev: doc._rev ?? this.rev() } as RawSanityDoc);
    return this;
  }
  snapshot() {
    return structuredClone([...this.docs.values()]).sort((a, b) => a._id.localeCompare(b._id));
  }
  async listProjectDocuments() {
    this.reads++;
    this.onRead?.(this.reads);
    if (this.fail === 'read' || (this.fail === 'read-after-commit' && this.transactionIds.size > 0)) throw new Error('Sanity read failed: HTTP 503');
    return structuredClone([...this.docs.values()].filter((d) => d._type === 'project'))
      .map((d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null)) as RawSanityDoc);
  }
  async getDocuments(ids: string[]) {
    const missing = ids.filter((id) => !this.docs.has(id));
    if (missing.length) throw new Error(`Documents disappeared while reading: ${missing.join(', ')}`);
    return structuredClone(ids.map((id) => this.docs.get(id)!));
  }
  async findDocumentsByBaseIds(ids: string[]) {
    const base = (id: string) => id.replace(/^drafts\./, '').replace(/^versions\.[^.]+\./, '');
    return structuredClone([...this.docs.values()].filter((d) => ids.includes(base(d._id))));
  }
  async findAssetsBySha1(hashes: string[]) {
    return this.assets.filter((a) => hashes.includes(a.sha1hash));
  }
  async commit(tx: MigrationTransaction, approved: ApprovedTargets) {
    assertSafeTransaction(tx, approved);
    this.beforeCommit?.();
    this.commits.push(structuredClone(tx));
    if (this.fail === 'reject') throw new MigrationCommitError('not_committed', 'HTTP 409');
    if (this.fail === 'unknown-before') throw new MigrationCommitError('unknown', 'socket hang up');
    if (this.transactionIds.has(tx.transactionId)) throw new MigrationCommitError('not_committed', 'HTTP 409 transaction ID already used');
    const staged = new Map(structuredClone([...this.docs]));
    for (const m of tx.mutations) {
      if ('create' in m) {
        if (staged.has(m.create._id)) throw new MigrationCommitError('not_committed', `HTTP 409 ${m.create._id} already exists`);
        staged.set(m.create._id, { ...m.create, _rev: this.rev() });
      } else {
        const doc = staged.get(m.patch.id);
        if (!doc || doc._rev !== m.patch.ifRevisionID) throw new MigrationCommitError('not_committed', `HTTP 409 revision mismatch for ${m.patch.id}`);
        const next: RawSanityDoc = { ...doc, _rev: this.rev() };
        for (const [k, v] of Object.entries(m.patch.setIfMissing)) if (next[k] === undefined) next[k] = v;
        staged.set(m.patch.id, next);
      }
    }
    this.docs = staged;
    this.transactionIds.add(tx.transactionId);
    if (this.fail === 'unknown-after') throw new MigrationCommitError('unknown', 'HTTP 502 after commit');
    return { transactionId: tx.transactionId, documentIds: tx.mutations.map((m) => ('create' in m ? m.create._id : m.patch.id)) };
  }
}

let sanity: MemorySanity;
const ctx = (over: Partial<PreflightContext> = {}): PreflightContext => ({
  env,
  root,
  config: { categories, defaultCategory, projectOverrides, featuredProjects, listSettings },
  githubUser: 'PeriBluGaming',
  fallback,
  adapter: sanity,
  fetchRepos: async () => inventory,
  validateSchema: async (_root, docs) => new Map(docs.map((d) => [d._id, []])),
  resolveLocalImage: (image, r) => validateProjectImage(image, r, join(root, 'public')),
  ...over,
});
const flags = (fp: string, extra: string[] = []) => ['--execute', '--confirm-dataset=production', `--plan=${fp}`, ...extra];
const unrelated = { _id: 'post-hello', _type: 'post', title: 'Hello' };

beforeEach(() => {
  sanity = new MemorySanity().put(unrelated);
});

describe('authenticated preflight', () => {
  it('proposes 8 CREATE with the intended featured order – read-only', async () => {
    const pre = await authenticatedPreflight(ctx());
    assert.deepEqual(pre.blockers, []);
    assert.deepEqual(pre.plan.summary.operations, { CREATE: 8, UPDATE: 0, UNCHANGED: 0, SKIP: 0, BLOCKED: 0 });
    assert.deepEqual(pre.plan.compatibility.proposedFeatured, INTENDED);
    assert.equal(pre.plan.state.draftsChecked, true);
    assert.match(pre.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(sanity.commits.length, 0);
  });

  it('is deterministic: same state → same fingerprint; any change → different fingerprint', async () => {
    const a = await authenticatedPreflight(ctx());
    assert.equal((await authenticatedPreflight(ctx())).fingerprint, a.fingerprint);
    sanity.put({ _id: 'drafts.something-else', _type: 'project', repo: 'Unrelated' });
    assert.notEqual((await authenticatedPreflight(ctx())).fingerprint, a.fingerprint);
  });

  const blockedBy = async (setup: () => void, pattern: RegExp, repoName?: string) => {
    setup();
    const pre = await authenticatedPreflight(ctx());
    assert.ok(pre.blockers.length > 0);
    if (repoName) assert.equal(pre.plan.projects.find((p) => p.repo === repoName)!.operation, 'BLOCKED');
    assert.match(JSON.stringify(pre.plan.projects.flatMap((p) => p.reasons)) + pre.blockers.join(' '), pattern);
  };

  it('blocks on duplicate documents for one repository', () =>
    blockedBy(() => sanity.put({ _id: 'a1', _type: 'project', repo: 'romm2switch' }).put({ _id: 'a2', _type: 'project', repo: 'ROMM2SWITCH' }), /Duplicate Sanity documents/, 'romm2switch'));

  it('blocks on a draft of a proposed document or of the same repository', async () => {
    await blockedBy(() => sanity.put({ _id: 'drafts.project-romm2switch', _type: 'project', repo: 'romm2switch' }), /drafts\.project-romm2switch/, 'romm2switch');
    sanity = new MemorySanity();
    await blockedBy(() => sanity.put({ _id: 'drafts.4f1c-random', _type: 'project', repo: 'ToyStory2Recomp' }), /drafts\.4f1c-random/, 'ToyStory2Recomp');
  });

  it('blocks on a release version of a proposed document', () =>
    blockedBy(() => sanity.put({ _id: 'versions.rLaunch.project-psxrecomp', _type: 'project', repo: 'psxrecomp' }), /versions\.rLaunch\.project-psxrecomp/, 'psxrecomp'));

  it('blocks when a proposed ID is used by a document of another type', () =>
    blockedBy(() => sanity.put({ _id: 'project-recomp-ui', _type: 'post' }), /project-recomp-ui \(post\)/, 'recomp-ui'));

  it('blocks on schema validation errors and when the schema cannot be checked', async () => {
    const withErrors = await authenticatedPreflight(ctx({ validateSchema: async (_r, docs) => new Map(docs.map((d) => [d._id, d._id === 'project-psxrecomp' ? ['tags: invalid'] : []])) }));
    assert.match(withErrors.blockers.join(' '), /BLOCKED project\(s\): psxrecomp/);
    const unchecked = await authenticatedPreflight(ctx({ validateSchema: async () => null }));
    assert.match(unchecked.blockers.join(' '), /schema validation could not run/);
  });

  it('blocks when GitHub is only available as the fallback snapshot', async () => {
    const pre = await authenticatedPreflight(ctx({ fetchRepos: async () => Promise.reject(new Error('rate limited')) }));
    assert.match(pre.blockers.join(' '), /fallback snapshot/);
  });

  it('fails on Sanity API errors instead of planning blindly', async () => {
    sanity.fail = 'read';
    await assert.rejects(authenticatedPreflight(ctx()), /HTTP 503/);
  });
});

describe('execution gates', () => {
  it('refuses without tokens, --execute, dataset acknowledgement or plan, or with repeated flags – before reading anything', async () => {
    const fp = (await authenticatedPreflight(ctx())).fingerprint;
    const reads = sanity.reads;
    const cases: [Partial<PreflightContext>, string[], RegExp][] = [
      [{ env: { ...env, [MIGRATION_WRITE_TOKEN_ENV]: '' } }, flags(fp), /SANITY_MIGRATION_WRITE_TOKEN is not set/],
      [{ env: { ...env, [MIGRATION_READ_TOKEN_ENV]: ' ' } }, flags(fp), /SANITY_MIGRATION_READ_TOKEN is not set .*no fallback to the write token/],
      [{ env: { ...env, [MIGRATION_READ_TOKEN_ENV]: WRITE_TOKEN } }, flags(fp), /must be different tokens/],
      [{}, [...flags(fp), '--execute'], /given more than once: --execute/],
      [{}, [...flags(fp), '--confirm-dataset=production'], /given more than once: --confirm-dataset/],
      [{}, ['--execute', '--confirm-dataset=production', `--plan=${'0'.repeat(64)}`, `--plan=${fp}`], /given more than once: --plan/],
      [{}, ['--confirm-dataset=production', `--plan=${fp}`], /--execute is missing/],
      [{}, ['--execute', `--plan=${fp}`], /--confirm-dataset=production is missing/],
      [{}, ['--execute', '--confirm-dataset=staging', `--plan=${fp}`], /does not match the configured dataset "production"/],
      [{}, ['--execute', '--confirm-dataset=production'], /--plan=<fingerprint> is missing/],
      [{}, ['--execute', '--confirm-dataset=production', '--plan=abc'], /64-character fingerprint/],
      [{}, [...flags(fp), '--force'], /Unknown arguments: --force/],
    ];
    for (const [over, argv, message] of cases) {
      const r = await executeMigration(argv, ctx(over));
      assert.equal(r.status, 'refused', String(argv));
      assert.match(r.messages.join(' '), message);
    }
    assert.equal(sanity.reads, reads); // nothing read, nothing written
    assert.equal(sanity.commits.length, 0);
  });

  it('a well-formed but different fingerprint is a stale plan', async () => {
    const r = await executeMigration(flags('0'.repeat(64)), ctx());
    assert.equal(r.status, 'stale');
    assert.equal(sanity.commits.length, 0);
  });

  it('rejects a plan approved before the state changed', async () => {
    const fp = (await authenticatedPreflight(ctx())).fingerprint;
    sanity.put({ _id: 'drafts.unrelated-change', _type: 'project', repo: 'SomethingNew' }); // someone edits in the Studio
    const r = await executeMigration(flags(fp), ctx());
    assert.equal(r.status, 'stale');
    assert.equal(sanity.commits.length, 0);
  });

  it('refuses when blockers exist even with every flag correct', async () => {
    sanity.put({ _id: 'drafts.project-romm2switch', _type: 'project', repo: 'romm2switch' });
    const fp = (await authenticatedPreflight(ctx())).fingerprint;
    const r = await executeMigration(flags(fp), ctx());
    assert.equal(r.status, 'refused');
    assert.equal(sanity.commits.length, 0);
  });

  it('re-reads right before writing and aborts if the state changed in between', async () => {
    const fp = (await authenticatedPreflight(ctx())).fingerprint;
    const start = sanity.reads;
    sanity.onRead = (n) => {
      if (n === start + 2) sanity.put({ _id: 'project-romm2switch', _type: 'project', repo: 'romm2switch', title: 'Edited meanwhile' });
    };
    const r = await executeMigration(flags(fp), ctx());
    assert.equal(r.status, 'stale');
    assert.equal(sanity.commits.length, 0);
  });
});

describe('execution', () => {
  it('writes exactly the 8 approved documents in one conditional transaction, then verifies', async () => {
    const before = sanity.snapshot();
    const pre = await authenticatedPreflight(ctx());
    const r = await executeMigration(flags(pre.fingerprint), ctx());
    assert.equal(r.status, 'committed_verified');
    assert.equal(sanity.commits.length, 1);
    const [tx] = sanity.commits;
    assert.equal(tx.transactionId, migrationTransactionId(pre.fingerprint));
    assert.ok(tx.mutations.every((m) => 'create' in m));
    assert.deepEqual(r.documentIds!.sort(), pre.plan.projects.map((p) => p.documentId!).sort());
    // unrelated documents untouched, no screenshots / assets written
    assert.deepEqual(sanity.docs.get('post-hello'), before.find((d) => d._id === 'post-hello'));
    for (const d of sanity.docs.values()) if (d._type === 'project') assert.equal('screenshots' in d, false);
    // the website now renders the intended featured order from Sanity (real merge)
    const after = await authenticatedPreflight(ctx());
    assert.deepEqual(after.plan.compatibility.currentFeatured, INTENDED);
    const docs = Object.fromEntries([...sanity.docs.values()].filter((d) => d._type === 'project').map((d) => [d.repo, d]));
    assert.deepEqual(INTENDED.map((n) => docs[n].featuredOrder), [0, 1, 2, 3, 4, 5]);
    assert.equal(docs.psxrecomp.featured, undefined);
    assert.equal(docs['recomp-ui'].featured, undefined);
  });

  it('is idempotent: a second run finds everything UNCHANGED and writes nothing', async () => {
    const first = await authenticatedPreflight(ctx());
    await executeMigration(flags(first.fingerprint), ctx());
    const second = await authenticatedPreflight(ctx());
    assert.deepEqual(second.plan.summary.operations, { CREATE: 0, UPDATE: 0, UNCHANGED: 8, SKIP: 0, BLOCKED: 0 });
    assert.notEqual(second.fingerprint, first.fingerprint);
    assert.equal((await executeMigration(flags(first.fingerprint), ctx())).status, 'stale'); // old approval is dead
    assert.equal((await executeMigration(flags(second.fingerprint), ctx())).status, 'nothing-to-do');
    assert.equal(sanity.commits.length, 1);
  });

  it('only adds missing fields to existing documents, conditioned on their revision', async () => {
    sanity.put({ _id: 'project-toystory2recomp', _type: 'project', repo: 'ToyStory2Recomp', title: 'Toy Story 2 Recomp', hidden: false, _rev: 'r-ts2' });
    const pre = await authenticatedPreflight(ctx());
    assert.equal(pre.plan.projects[0].operation, 'UPDATE');
    const tx = buildTransaction(pre.plan, pre.fingerprint);
    const patch = tx.mutations.find((m) => 'patch' in m) as { patch: { id: string; ifRevisionID: string; setIfMissing: Record<string, unknown> } };
    assert.deepEqual(patch.patch, {
      id: 'project-toystory2recomp', ifRevisionID: 'r-ts2',
      setIfMissing: { description: projectOverrides.ToyStory2Recomp.description, category: 'playstation', tags: ['PS1', 'Recomp'], featured: true, featuredOrder: 0, accent: 'cyan' },
    });
    const r = await executeMigration(flags(pre.fingerprint), ctx());
    assert.equal(r.status, 'committed_verified');
    assert.equal(sanity.docs.get('project-toystory2recomp')!.title, 'Toy Story 2 Recomp');
  });

  it('a concurrent edit at commit time rejects the whole transaction – nothing is written', async () => {
    const pre = await authenticatedPreflight(ctx());
    sanity.beforeCommit = () => sanity.put({ _id: 'project-romm2switch', _type: 'project', repo: 'romm2switch', title: 'Created in the Studio' });
    const r = await executeMigration(flags(pre.fingerprint), ctx());
    assert.equal(r.status, 'not_committed');
    assert.match(r.messages[0], /atomic – nothing was written/);
    const projects = [...sanity.docs.values()].filter((d) => d._type === 'project');
    assert.deepEqual(projects.map((d) => d.title), ['Created in the Studio']); // the Studio edit survives, nothing else exists
  });

  it('partial failure and recovery: an unknown outcome requires a fresh preflight', async () => {
    // Case 1: the commit did not happen – the same plan is still current and can be executed.
    const pre = await authenticatedPreflight(ctx());
    sanity.fail = 'unknown-before';
    assert.equal((await executeMigration(flags(pre.fingerprint), ctx())).status, 'unknown');
    sanity.fail = undefined;
    const retry = await authenticatedPreflight(ctx());
    assert.equal(retry.fingerprint, pre.fingerprint);
    assert.equal((await executeMigration(flags(retry.fingerprint), ctx())).status, 'committed_verified');

    // Case 2: the commit happened but the response was lost – the old plan is stale, a new preflight shows UNCHANGED.
    sanity = new MemorySanity();
    const pre2 = await authenticatedPreflight(ctx());
    sanity.fail = 'unknown-after';
    assert.equal((await executeMigration(flags(pre2.fingerprint), ctx())).status, 'unknown');
    sanity.fail = undefined;
    assert.equal((await executeMigration(flags(pre2.fingerprint), ctx())).status, 'stale');
    const after = await authenticatedPreflight(ctx());
    assert.equal(after.plan.summary.operations.UNCHANGED, 8);
  });

  it('a rejected transaction leaves Sanity untouched', async () => {
    const before = sanity.snapshot();
    const pre = await authenticatedPreflight(ctx());
    sanity.fail = 'reject';
    assert.equal((await executeMigration(flags(pre.fingerprint), ctx())).status, 'not_committed');
    assert.deepEqual(sanity.snapshot(), before);
  });
});

describe('post-commit outcomes (I-1) and the draft race (I-2)', () => {
  it('a failing verification read after a confirmed commit is committed_unverified – never hidden, never retried', async () => {
    const pre = await authenticatedPreflight(ctx());
    sanity.fail = 'read-after-commit';
    const r = await executeMigration(flags(pre.fingerprint), ctx());
    assert.equal(r.status, 'committed_unverified');
    assert.equal(r.transactionId, migrationTransactionId(pre.fingerprint));
    assert.deepEqual(r.documentIds, ALL_IDS);
    const text = r.messages.join('\n');
    assert.match(text, /COMMITTED but NOT VERIFIED/);
    assert.match(text, /verification read failed: Sanity read failed: HTTP 503/);
    assert.match(text, /may already be live/);
    assert.match(text, /fresh preflight/);
    assert.equal(sanity.commits.length, 1); // no automatic retry
    assert.equal([...sanity.docs.values()].filter((d) => d._type === 'project').length, 8); // and the documents ARE live
  });

  it('Sanity confirming other document IDs than planned is committed_unverified', async () => {
    const pre = await authenticatedPreflight(ctx());
    const real = sanity.commit.bind(sanity);
    sanity.commit = async (tx, approved) => ({ ...(await real(tx, approved)), documentIds: ['project-psxrecomp'] });
    const r = await executeMigration(flags(pre.fingerprint), ctx());
    assert.equal(r.status, 'committed_unverified');
    assert.match(r.messages.join('\n'), /did not report these planned documents: project-bugsbunnylostintimerecomp/);
  });

  it('a draft created between the last read and the commit is reported with its ID after the commit', async () => {
    const pre = await authenticatedPreflight(ctx());
    // Simulates an editor saving in the Studio right before the commit – the create still succeeds (it only guards
    // the published ID), which is exactly the documented race window.
    sanity.beforeCommit = () => sanity.put({ _id: 'drafts.project-romm2switch', _type: 'project', repo: 'romm2switch', title: 'Draft from the Studio' });
    const r = await executeMigration(flags(pre.fingerprint), ctx());
    assert.equal(r.status, 'committed_unverified');
    assert.deepEqual(r.conflicts, ['drafts.project-romm2switch']);
    assert.match(r.messages.join('\n'), /project-romm2switch is BLOCKED/);
    assert.match(r.messages.join('\n'), /Conflicting documents .*drafts\.project-romm2switch/);
    // nothing was deleted or overwritten: the draft is untouched, the published document exists
    assert.equal(sanity.docs.get('drafts.project-romm2switch')!.title, 'Draft from the Studio');
    assert.ok(sanity.docs.has('project-romm2switch'));
    assert.equal(sanity.commits.length, 1);
  });

  it('a commit with an unknown outcome is reported as unknown with the transaction and planned IDs', async () => {
    const pre = await authenticatedPreflight(ctx());
    sanity.fail = 'unknown-after';
    const r = await executeMigration(flags(pre.fingerprint), ctx());
    assert.equal(r.status, 'unknown');
    assert.equal(r.documentIds, undefined); // never claims confirmed IDs
    assert.deepEqual(r.plannedDocumentIds, ALL_IDS);
    assert.match(r.messages.join('\n'), /may already be live\. Nothing is retried automatically/);
  });

  it('is idempotent after a verified migration: nothing to do, nothing written', async () => {
    const first = await authenticatedPreflight(ctx());
    assert.equal((await executeMigration(flags(first.fingerprint), ctx())).status, 'committed_verified');
    const snapshot = sanity.snapshot();
    const again = await authenticatedPreflight(ctx());
    assert.deepEqual(again.blockers, []);
    assert.equal((await executeMigration(flags(again.fingerprint), ctx())).status, 'nothing-to-do');
    assert.deepEqual(sanity.snapshot(), snapshot);
    assert.equal(sanity.commits.length, 1);
  });
});

describe('explicit null values (M-4)', () => {
  it('a stored null is a conflict: BLOCKED, never overwritten via setIfMissing', async () => {
    sanity.put({ _id: 'project-toystory2recomp', _type: 'project', repo: 'ToyStory2Recomp', description: null, _rev: 'r-ts2' });
    const pre = await authenticatedPreflight(ctx());
    const ts2 = pre.plan.projects.find((p) => p.repo === 'ToyStory2Recomp')!;
    assert.equal(ts2.operation, 'BLOCKED');
    assert.match(ts2.reasons.join(' '), /description \(stored null\)/);
    assert.equal(ts2.comparison.find((c) => c.field === 'description')!.status, 'conflict');
    assert.ok(pre.blockers.length > 0);
    assert.equal((await executeMigration(flags(pre.fingerprint), ctx())).status, 'refused');
    assert.equal(sanity.commits.length, 0);
  });

  it('a missing field (not null) is still added by an UPDATE', async () => {
    sanity.put({ _id: 'project-toystory2recomp', _type: 'project', repo: 'ToyStory2Recomp', _rev: 'r-ts2' });
    const pre = await authenticatedPreflight(ctx());
    const ts2 = pre.plan.projects.find((p) => p.repo === 'ToyStory2Recomp')!;
    assert.equal(ts2.operation, 'UPDATE');
    assert.equal(ts2.comparison.find((c) => c.field === 'description')!.status, 'add');
  });

  it('fails closed if a document changes between the list read and the exact read', async () => {
    sanity.put({ _id: 'project-toystory2recomp', _type: 'project', repo: 'ToyStory2Recomp', _rev: 'r-ts2' });
    const real = sanity.getDocuments.bind(sanity);
    sanity.getDocuments = async (ids) => (await real(ids)).map((d) => ({ ...d, _rev: 'r-newer' }));
    await assert.rejects(authenticatedPreflight(ctx()), /changed while reading/);
  });
});

describe('plan fingerprint', () => {
  it('changes when an editorial configuration value changes', async () => {
    const a = await authenticatedPreflight(ctx());
    const overrides = { ...projectOverrides, ToyStory2Recomp: { ...projectOverrides.ToyStory2Recomp, description: 'Changed description' } };
    const b = await authenticatedPreflight(ctx({ config: { categories, defaultCategory, projectOverrides: overrides, featuredProjects, listSettings } }));
    assert.notEqual(b.fingerprint, a.fingerprint);
  });

  it('changes when only the revision of an existing document changes', async () => {
    sanity.put({ _id: 'project-toystory2recomp', _type: 'project', repo: 'ToyStory2Recomp', _rev: 'r1' });
    const a = await authenticatedPreflight(ctx());
    sanity.put({ _id: 'project-toystory2recomp', _type: 'project', repo: 'ToyStory2Recomp', _rev: 'r2' });
    const b = await authenticatedPreflight(ctx());
    assert.deepEqual(b.plan.projects.map((p) => p.operation), a.plan.projects.map((p) => p.operation));
    assert.notEqual(b.fingerprint, a.fingerprint);
  });
});

describe('argument parsing', () => {
  it('records repeated flags instead of silently taking the last value', () => {
    assert.deepEqual(parseExecuteArgs(['--plan=a', '--plan=b', '--execute', '--execute']).duplicates, ['--plan', '--execute']);
    assert.deepEqual(parseExecuteArgs(['--execute', '--plan=a', '--confirm-dataset=production']).duplicates, []);
  });
});

describe('transaction ID (Sanity: at most 64 characters)', () => {
  const hex = (c: string) => c.repeat(64);

  it('is at most 64 characters for every fingerprint, and the local check enforces the limit', async () => {
    assert.equal(MAX_TRANSACTION_ID_LENGTH, 64);
    const pre = await authenticatedPreflight(ctx());
    for (const fp of [pre.fingerprint, hex('0'), hex('f')]) {
      const id = migrationTransactionId(fp);
      assert.ok(id.length <= 64, `${id} has ${id.length} characters`);
      assert.match(id, /^periblugaming-project-migration-[0-9a-f]{32}$/);
    }
    const tx = buildTransaction(pre.plan, pre.fingerprint);
    assert.ok(tx.transactionId.length <= 64);
    assertSafeTransaction(tx, { create: new Set(pre.plan.projects.map((p) => p.documentId!)), update: new Set() });
    // The ID shape Sanity rejected in production (prefix + 40 hex = 72 characters) is refused locally, before sending.
    const tooLong = { ...tx, transactionId: `periblugaming-project-migration-${pre.fingerprint.slice(0, 40)}` };
    assert.equal(tooLong.transactionId.length, 72);
    assert.throws(() => assertSafeTransaction(tooLong, { create: new Set(pre.plan.projects.map((p) => p.documentId!)), update: new Set() }), /at most 64 characters/);
  });

  it('is deterministic and tied to the approved plan fingerprint', async () => {
    const a = await authenticatedPreflight(ctx());
    const b = await authenticatedPreflight(ctx());
    assert.equal(b.fingerprint, a.fingerprint);
    assert.equal(buildTransaction(b.plan, b.fingerprint).transactionId, buildTransaction(a.plan, a.fingerprint).transactionId);
    assert.equal(migrationTransactionId(a.fingerprint), `periblugaming-project-migration-${a.fingerprint.slice(0, 32)}`);
  });

  it('differs for different plans', async () => {
    const a = await authenticatedPreflight(ctx());
    sanity.put({ _id: 'project-toystory2recomp', _type: 'project', repo: 'ToyStory2Recomp', _rev: 'r1' });
    const b = await authenticatedPreflight(ctx());
    assert.notEqual(b.fingerprint, a.fingerprint);
    assert.notEqual(migrationTransactionId(b.fingerprint), migrationTransactionId(a.fingerprint));
    assert.notEqual(migrationTransactionId(hex('a')), migrationTransactionId(`${'a'.repeat(31)}b${'a'.repeat(32)}`));
  });

  it('refuses anything that is not a plan fingerprint', () => {
    for (const bad of ['', 'abc', hex('g'), `${hex('a')}0`, hex('A')]) assert.throws(() => migrationTransactionId(bad), /64-character plan fingerprint/, bad);
  });
});

describe('transaction safety (assertSafeTransaction)', () => {
  const approved: ApprovedTargets = { create: new Set(['project-a']), update: new Set(['project-b']) };
  const tx = (...mutations: unknown[]) => ({ transactionId: 'periblugaming-project-migration-x', mutations }) as MigrationTransaction;
  const create = { create: { _id: 'project-a', _type: 'project', repo: 'a' } };

  it('allows plan-approved creates and conditional setIfMissing patches', () => {
    assertSafeTransaction(tx(create, { patch: { id: 'project-b', ifRevisionID: 'r1', setIfMissing: { title: 'B' } } }), approved);
  });

  it('refuses deletions, replacements, unconditional or overwriting patches, uploads and unapproved targets', () => {
    const bad: [unknown, RegExp][] = [
      [{ delete: { id: 'project-a' } }, /"delete" is not allowed/],
      [{ createOrReplace: { _id: 'project-a', _type: 'project' } }, /"createOrReplace" is not allowed/],
      [{ createIfNotExists: { _id: 'project-a', _type: 'project' } }, /not allowed/],
      [{ patch: { id: 'project-b', setIfMissing: { title: 'B' } } }, /only use id, ifRevisionID, setIfMissing/],
      [{ patch: { id: 'project-b', ifRevisionID: 'r1', set: { title: 'B' } } }, /only use id, ifRevisionID, setIfMissing/],
      [{ patch: { id: 'project-b', ifRevisionID: 'r1', setIfMissing: { title: 'B' }, unset: ['x'] } }, /only use/],
      [{ patch: { id: 'project-b', ifRevisionID: 'r1', setIfMissing: { screenshots: [] } } }, /non-migrated fields/],
      [{ create: { _id: 'project-a', _type: 'project', screenshots: [{ asset: { _ref: 'image-x' } }] } }, /non-migrated fields \(screenshots\)/],
      [{ create: { _id: 'project-z', _type: 'project' } }, /not an approved CREATE/],
      [{ create: { _id: 'drafts.project-a', _type: 'project' } }, /published project document/],
      [{ create: { _id: 'project-a', _type: 'post' } }, /published project document/],
      [{ patch: { id: 'post-hello', ifRevisionID: 'r1', setIfMissing: { title: 'x' } } }, /not an approved UPDATE/],
    ];
    for (const [m, message] of bad) assert.throws(() => assertSafeTransaction(tx(m), approved), message, JSON.stringify(m));
    assert.throws(() => assertSafeTransaction(tx(create, create), approved), /appears twice/);
    assert.throws(() => assertSafeTransaction(tx(), approved), /no mutations/);
  });
});

describe('HTTP adapter (fetch stub – no network)', () => {
  const target = { projectId: 'hyyn359x', dataset: 'production', apiVersion: '2025-02-19' };
  const stub = (respond: (url: URL, init: RequestInit) => Response | Promise<Response>, tokens: { readToken: string; writeToken?: string } = { readToken: READ_TOKEN, writeToken: WRITE_TOKEN }) => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => (calls.push({ url, init }), respond(url, init))) as typeof fetch;
    return { calls, adapter: createHttpAdapter({ ...target, ...tokens, fetchImpl }) };
  };
  const auth = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;
  const tx = { transactionId: 'periblugaming-project-migration-x', mutations: [{ create: { _id: 'project-a', _type: 'project' as const, repo: 'a' } }] };
  const ok: ApprovedTargets = { create: new Set(['project-a']), update: new Set() };
  const outcome = (expected: string) => (e: MigrationCommitError) => e instanceof MigrationCommitError && e.outcome === expected;

  it('reads with the raw perspective and the READ token only, never following redirects', async () => {
    const { calls, adapter } = stub((url) => new Response(JSON.stringify(url.pathname.includes('/doc/') ? { documents: [{ _id: 'project-a' }] } : { result: [] })));
    await adapter.listProjectDocuments();
    await adapter.getDocuments(['project-a']);
    const [list, doc] = calls;
    assert.equal(list.init.method, 'GET');
    assert.equal(list.url.searchParams.get('perspective'), 'raw');
    assert.equal(list.url.host, 'hyyn359x.api.sanity.io');
    assert.equal(doc.url.pathname, '/v2025-02-19/data/doc/production/project-a');
    for (const { url, init } of calls) {
      assert.doesNotMatch(url.href, new RegExp(`${READ_TOKEN}|${WRITE_TOKEN}`));
      assert.equal(auth(init), `Bearer ${READ_TOKEN}`);
      assert.equal(init.redirect, 'error');
    }
  });

  it('commits with the WRITE token only, never following redirects', async () => {
    const { calls, adapter } = stub(() => new Response(JSON.stringify({ transactionId: 'tx1', results: [{ id: 'project-a' }] })));
    assert.deepEqual(await adapter.commit(tx, ok), { transactionId: 'tx1', documentIds: ['project-a'] });
    assert.equal(calls[0].init.method, 'POST');
    assert.match(calls[0].url.pathname, /\/data\/mutate\/production$/);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), tx);
    assert.equal(auth(calls[0].init), `Bearer ${WRITE_TOKEN}`);
    assert.equal(calls[0].init.redirect, 'error');
  });

  it('cannot commit without a write token and cannot be created without a read token', async () => {
    const readOnly = stub(() => new Response('{}'), { readToken: READ_TOKEN });
    await assert.rejects(readOnly.adapter.commit(tx, ok), (e: MigrationCommitError) => outcome('not_committed')(e) && /no write token/.test(e.message));
    assert.equal(readOnly.calls.length, 0);
    assert.throws(() => createHttpAdapter({ ...target, readToken: '', writeToken: WRITE_TOKEN }), /read token is required/);
  });

  it('never leaks either token in error messages', async () => {
    const body = `invalid tokens ${READ_TOKEN} / ${WRITE_TOKEN}`;
    const clean = (e: Error) => !e.message.includes(READ_TOKEN) && !e.message.includes(WRITE_TOKEN) && /\*\*\*/.test(e.message);
    await assert.rejects(stub(() => new Response(body, { status: 401 })).adapter.listProjectDocuments(), clean);
    await assert.rejects(stub(() => new Response(body, { status: 403 })).adapter.commit(tx, ok), clean);
    await assert.rejects(stub(() => new Response(body, { status: 503 })).adapter.commit(tx, ok), clean);
    await assert.rejects(stub(() => Promise.reject(new Error(`connect failed ${WRITE_TOKEN}`))).adapter.commit(tx, ok), clean);
    await assert.rejects(stub(() => Promise.reject(new Error(`connect failed ${READ_TOKEN}`))).adapter.getDocuments(['project-a']), clean);
  });

  it('checks the transaction before sending', async () => {
    const unsafe = stub(() => new Response('{}'));
    await assert.rejects(unsafe.adapter.commit(tx, { create: new Set(), update: new Set() }), (e: MigrationCommitError) => outcome('not_committed')(e) && /not an approved CREATE/.test(e.message));
    assert.equal(unsafe.calls.length, 0);
  });

  it('classifies commit outcomes – only a 4xx is a confirmed failure', async () => {
    await assert.rejects(stub(() => new Response('conflict', { status: 409 })).adapter.commit(tx, ok), outcome('not_committed'));
    await assert.rejects(stub(() => new Response('bad gateway', { status: 502 })).adapter.commit(tx, ok), outcome('unknown'));
    await assert.rejects(stub(() => new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example/' } })).adapter.commit(tx, ok), outcome('unknown'));
    // A timeout during the commit is NOT a confirmed failure.
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    await assert.rejects(stub(() => Promise.reject(timeout)).adapter.commit(tx, ok), outcome('unknown'));
    // The body breaking off after the headers is NOT a confirmed failure either.
    const broken = new Response(new ReadableStream({ start: (c) => c.error(new Error('connection reset')) }));
    await assert.rejects(stub(() => broken).adapter.commit(tx, ok), outcome('unknown'));
  });

  it('treats malformed successful responses as unknown, never as success or failure', async () => {
    const bodies = ['not json', '', 'null', '{}', JSON.stringify({ results: [{ id: 'project-a' }] }), JSON.stringify({ transactionId: 'tx1' }),
      JSON.stringify({ transactionId: 'tx1', results: {} }), JSON.stringify({ transactionId: 'tx1', results: [{ id: 42 }] }), JSON.stringify({ transactionId: 'tx1', results: [null] })];
    for (const body of bodies) await assert.rejects(stub(() => new Response(body, { status: 200 })).adapter.commit(tx, ok), outcome('unknown'), body);
  });

  it('rejects malformed successful read responses instead of planning on them', async () => {
    for (const body of ['not json', 'null', '{}', JSON.stringify({ result: {} })]) {
      await assert.rejects(stub(() => new Response(body)).adapter.listProjectDocuments(), /not JSON|unexpected response/, body);
    }
    for (const body of ['{}', JSON.stringify({ documents: [null] }), JSON.stringify({ documents: [] })]) {
      await assert.rejects(stub(() => new Response(body)).adapter.getDocuments(['project-a']), /unexpected response|disappeared/, body);
    }
  });

  it('has no upload or delete code at all', () => {
    for (const file of ['src/lib/sanity-migration-adapter.ts', 'src/lib/project-migration-execute.ts', 'scripts/sanity-project-migration.ts']) {
      const code = readFileSync(join(root, file), 'utf8');
      assert.doesNotMatch(code, /assets\/images|assets\.upload|\/assets\/|uploadAsset|\{ delete:|createOrReplace: \{/, file);
    }
  });
});

describe('HTTP adapter redirects (local servers only)', () => {
  /** Two local servers: "sanity" answers every request with a redirect to "elsewhere". */
  const withServers = async (run: (adapter: SanityMigrationAdapter, seen: { sanity: IncomingHttpHeaders[]; elsewhere: IncomingHttpHeaders[] }) => Promise<void>) => {
    const seen = { sanity: [] as IncomingHttpHeaders[], elsewhere: [] as IncomingHttpHeaders[] };
    const elsewhere = createServer((req, res) => (seen.elsewhere.push(req.headers), res.end('{"result":[]}')));
    const sanityServer = createServer((req, res) => {
      seen.sanity.push(req.headers);
      req.resume();
      res.writeHead(307, { Location: `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/steal` }).end();
    });
    await Promise.all([elsewhere, sanityServer].map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))));
    const port = (sanityServer.address() as AddressInfo).port;
    // Same request, but sent to the local "sanity" server instead of api.sanity.io.
    const fetchImpl = ((url: URL, init: RequestInit) => fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init)) as typeof fetch;
    try {
      await run(createHttpAdapter({ projectId: 'hyyn359x', dataset: 'production', apiVersion: '2025-02-19', readToken: READ_TOKEN, writeToken: WRITE_TOKEN, fetchImpl }), seen);
    } finally {
      await Promise.all([elsewhere, sanityServer].map((s) => new Promise((resolve) => s.close(resolve))));
    }
  };

  it('a redirect fails the read and the commit – no second request, no token sent anywhere else', () =>
    withServers(async (adapter, seen) => {
      await assert.rejects(adapter.listProjectDocuments(), (e: Error) => /Sanity read failed/.test(e.message) && !e.message.includes(READ_TOKEN));
      await assert.rejects(adapter.getDocuments(['project-a']), /Sanity read failed/);
      await assert.rejects(adapter.commit({ transactionId: 'periblugaming-project-migration-x', mutations: [{ create: { _id: 'project-a', _type: 'project', repo: 'a' } }] }, { create: new Set(['project-a']), update: new Set() }),
        (e: MigrationCommitError) => e.outcome === 'unknown' && !e.message.includes(WRITE_TOKEN));
      assert.equal(seen.sanity.length, 3);
      assert.equal(seen.elsewhere.length, 0);
    }));
});

describe('CLI', () => {
  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(root, 'scripts/sanity-project-migration.ts'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SANITY_PROJECT_ID: 'hyyn359x', ...extraEnv } });
  const executeArgs = ['execute', '--execute', '--confirm-dataset=production', `--plan=${'a'.repeat(64)}`];

  it('preflight needs the read token – the write token is neither required nor a substitute', () => {
    const r = run(['preflight'], { [MIGRATION_WRITE_TOKEN_ENV]: WRITE_TOKEN });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /SANITY_MIGRATION_READ_TOKEN is not set/);
  });

  it('execute needs both tokens, different from each other – refused before any network access', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ [MIGRATION_READ_TOKEN_ENV]: READ_TOKEN }, /SANITY_MIGRATION_WRITE_TOKEN is not set/],
      [{ [MIGRATION_WRITE_TOKEN_ENV]: WRITE_TOKEN }, /SANITY_MIGRATION_READ_TOKEN is not set/],
      [{ [MIGRATION_READ_TOKEN_ENV]: WRITE_TOKEN, [MIGRATION_WRITE_TOKEN_ENV]: WRITE_TOKEN }, /must be different tokens/],
    ];
    for (const [tokens, message] of cases) {
      const r = run(executeArgs, tokens);
      assert.equal(r.status, 2);
      assert.match(r.stderr, message);
      assert.ok(!r.stderr.includes(READ_TOKEN) && !r.stderr.includes(WRITE_TOKEN) && !r.stdout.includes(WRITE_TOKEN));
    }
  });

  it('refuses unknown commands, preflight arguments and repeated flags', () => {
    const tokens = { [MIGRATION_READ_TOKEN_ENV]: READ_TOKEN, [MIGRATION_WRITE_TOKEN_ENV]: WRITE_TOKEN };
    assert.equal(run(['migrate']).status, 2);
    assert.equal(run(['preflight', '--execute'], tokens).status, 2);
    const dup = run([...executeArgs, `--plan=${'b'.repeat(64)}`], tokens);
    assert.equal(dup.status, 2);
    assert.match(dup.stderr, /given more than once: --plan/);
  });

  it('the plan fingerprint covers the target dataset', async () => {
    const pre = await authenticatedPreflight(ctx());
    assert.notEqual(planFingerprint(pre.plan, { projectId: 'hyyn359x', dataset: 'staging' }), pre.fingerprint);
  });
});
