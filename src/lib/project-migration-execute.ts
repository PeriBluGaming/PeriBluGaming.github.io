/**
 * Controlled Sanity project migration: authenticated preflight + explicitly authorised execution.
 * Builds on the dry-run planner (src/lib/project-migration.ts) – same proposals, same classification.
 *
 * Execution only happens if ALL of these hold (each is checked, in this order):
 *   1. SANITY_MIGRATION_READ_TOKEN and SANITY_MIGRATION_WRITE_TOKEN are set (and differ), `--execute` is given,
 *      `--confirm-dataset=<dataset>` names the configured dataset, `--plan=<fingerprint>` is given, no argument is
 *      unknown or repeated;
 *   2. a fresh authenticated preflight (drafts and release versions included) has no blockers;
 *   3. its plan fingerprint equals the one the operator approved (otherwise the plan is stale);
 *   4. a second read immediately before writing still yields the same fingerprint;
 *   5. the transaction contains only plan-approved, conditional mutations (create / setIfMissing + ifRevisionID).
 * Afterwards a third read verifies that every migrated document is UNCHANGED.
 *
 * Outcomes are never guessed: a commit is only `committed_verified` if Sanity confirmed it AND the verification read
 * shows every written document as UNCHANGED. A confirmed commit whose verification fails is `committed_unverified`;
 * an unclear commit (timeout, 5xx, unreadable response) is `unknown`. Neither is ever retried automatically.
 *
 * Known race (cannot be closed with Sanity's mutation API): a draft or release version created in the Studio
 * between the last read (gate 4) and the commit is not seen by the transaction – `create` and `ifRevisionID` only
 * guard the published document. The verification read detects it (the project becomes BLOCKED by that draft), the
 * result is `committed_unverified` and names the conflicting document IDs. Operators must not edit project documents
 * in the Studio while a migration runs.
 */
import type { RepoData } from './github.ts';
import { fetchPublicRepos } from './github.ts';
import { readBlogConfig } from './blog/config.ts';
import {
  MIGRATED_FIELDS,
  planFingerprint,
  planMigration,
  proposedDocuments,
  type ExistingProjectDoc,
  type MigrationPlan,
  type PlanInput,
  type RelatedDoc,
} from './project-migration.ts';
import { localScreenshots, validateWithStudioSchema } from './project-migration-io.ts';
import type { MergeConfig } from './project-merge.ts';
import { MAX_TRANSACTION_ID_LENGTH, MigrationCommitError, type ApprovedTargets, type MigrationTransaction, type SanityMigrationAdapter } from './sanity-migration-adapter.ts';

/** Viewer token: every authenticated read (preflight, gates, verification). Never used for writing. */
export const MIGRATION_READ_TOKEN_ENV = 'SANITY_MIGRATION_READ_TOKEN';
/** Editor token: only the single mutate request of an authorised execution. Not needed for the preflight. */
export const MIGRATION_WRITE_TOKEN_ENV = 'SANITY_MIGRATION_WRITE_TOKEN';
const FINGERPRINT = /^[0-9a-f]{64}$/;

export interface Target {
  projectId: string;
  dataset: string;
  apiVersion: string;
}

export function migrationTarget(env: Record<string, string | undefined>): Target {
  const c = readBlogConfig({ SANITY_PROJECT_ID: env.SANITY_PROJECT_ID, SANITY_DATASET: env.SANITY_DATASET, SANITY_API_VERSION: env.SANITY_API_VERSION });
  if (c.mode !== 'sanity') throw new Error('SANITY_PROJECT_ID is not set.');
  return { projectId: c.projectId, dataset: c.dataset, apiVersion: c.apiVersion };
}

export interface PreflightContext {
  env: Record<string, string | undefined>;
  root: string;
  config: MergeConfig;
  githubUser: string;
  fallback: { fetchedAt: string; repos: RepoData[] };
  adapter: SanityMigrationAdapter;
  fetchRepos?: typeof fetchPublicRepos;
  /** Defaults to the real Studio schema (null if the Studio dependencies are missing). */
  validateSchema?: typeof validateWithStudioSchema;
  resolveLocalImage: PlanInput['resolveLocalImage'];
}

export interface Preflight {
  plan: MigrationPlan;
  fingerprint: string;
  target: Target;
  /** Reasons that forbid execution. Empty = executable (or nothing to do). */
  blockers: string[];
}

/** Read-only. Never calls adapter.commit. */
export async function authenticatedPreflight(ctx: PreflightContext): Promise<Preflight> {
  const target = migrationTarget(ctx.env);

  let repos: RepoData[];
  let githubSource: string;
  let githubLive = true;
  try {
    repos = await (ctx.fetchRepos ?? fetchPublicRepos)(ctx.githubUser, {});
    githubSource = `live GitHub API (${repos.length} public repositories of ${ctx.githubUser})`;
  } catch (err) {
    githubLive = false;
    repos = ctx.fallback.repos;
    githubSource = `FALLBACK snapshot from ${ctx.fallback.fetchedAt} (GitHub unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }

  // Raw perspective: published documents, drafts and release versions.
  const raw = await ctx.adapter.listProjectDocuments();
  const isPublished = (id: string) => !id.startsWith('drafts.') && !id.startsWith('versions.');
  const listed = raw.filter((d) => d._type === 'project' && isPublished(d._id));

  // GROQ cannot tell an explicit null from a missing field: take the migrated fields from the exact stored documents.
  const exact = new Map((await ctx.adapter.getDocuments(listed.map((d) => d._id))).map((d) => [d._id, d]));
  const existing = listed.map((d) => {
    const stored = exact.get(d._id);
    if (!stored || stored._rev !== d._rev) throw new Error(`${d._id} changed while reading – run the preflight again.`);
    const doc: Record<string, unknown> = { ...d };
    for (const field of MIGRATED_FIELDS) {
      if (Object.hasOwn(stored, field)) doc[field] = stored[field];
      else delete doc[field];
    }
    return doc as unknown as ExistingProjectDoc;
  });
  const related: RelatedDoc[] = raw.filter((d) => !isPublished(d._id)).map(({ _id, _type, _rev, repo }) => ({ _id, _type, _rev, repo }));

  const screenshots = localScreenshots(ctx.config, ctx.root);
  const hashes = screenshots.map((s) => s.sha1).filter((h): h is string => h !== null);
  const assets = new Map((await ctx.adapter.findAssetsBySha1(hashes)).map((a) => [a.sha1hash, a._id]));
  for (const s of screenshots) s.sanityAssetId = (s.sha1 && assets.get(s.sha1)) || null;

  const base: PlanInput = {
    config: ctx.config,
    repos,
    githubSource,
    existing,
    related,
    sanitySource: `${target.projectId}/${target.dataset}, authenticated raw read: ${existing.length} published project document(s), ${related.length} draft/version document(s)`,
    screenshots,
    resolveLocalImage: ctx.resolveLocalImage,
  };

  // Documents of any type that occupy a proposed ID (or a draft / version of it).
  const first = planMigration(base);
  const ids = first.projects.map((p) => p.documentId).filter((id): id is string => id !== null);
  const known = new Set([...existing, ...related].map((d) => d._id));
  for (const d of await ctx.adapter.findDocumentsByBaseIds(ids)) {
    if (!known.has(d._id)) related.push({ _id: d._id, _type: d._type, _rev: d._rev, repo: d.repo });
  }

  const draft = planMigration(base);
  const schemaErrors = await (ctx.validateSchema ?? validateWithStudioSchema)(ctx.root, proposedDocuments(draft) as never, existing);
  const plan = planMigration({ ...base, schemaErrors, schemaValidation: schemaErrors ? 'Studio schema (Sanity validation engine, offline)' : undefined });
  return { plan, fingerprint: planFingerprint(plan, target), target, blockers: executionBlockers(plan, { githubLive, schemaChecked: schemaErrors !== null }) };
}

/** Everything that forbids writing, independent of the operator's flags. */
export function executionBlockers(plan: MigrationPlan, checks: { githubLive: boolean; schemaChecked: boolean }): string[] {
  const b: string[] = [];
  const blocked = plan.projects.filter((p) => p.operation === 'BLOCKED');
  if (blocked.length) b.push(`${blocked.length} BLOCKED project(s): ${blocked.map((p) => p.repo).join(', ')}`);
  if (!checks.githubLive) b.push('GitHub inventory comes from the fallback snapshot – re-run with GitHub available.');
  if (!checks.schemaChecked) b.push('Studio schema validation could not run – install the Studio dependencies (cd studio && npm ci).');
  if (!plan.state.draftsChecked) b.push('Drafts and release versions were not checked (authenticated read required).');
  const c = plan.compatibility;
  const unintended = c.differences.filter((d) => !d.intended);
  if (unintended.length) b.push(`Unintended presentation changes: ${unintended.map((d) => `${d.name}.${d.field}`).join(', ')}`);
  const moved = c.positionChanges.filter((d) => !d.intended);
  if (moved.length) b.push(`Unintended featured position changes: ${moved.map((d) => d.name).join(', ')}`);
  if (c.removed.length) b.push(`Cards would disappear: ${c.removed.join(', ')}`);
  return b;
}

export interface ExecuteArgs {
  execute: boolean;
  confirmDataset?: string;
  plan?: string;
  unknown: string[];
  /** Flags given more than once – refused instead of silently taking one of the values. */
  duplicates: string[];
}

export function parseExecuteArgs(argv: string[]): ExecuteArgs {
  const args: ExecuteArgs = { execute: false, unknown: [], duplicates: [] };
  const seen = new Set<string>();
  const once = (flag: string) => {
    if (seen.has(flag) && !args.duplicates.includes(flag)) args.duplicates.push(flag);
    seen.add(flag);
  };
  for (const a of argv) {
    if (a === '--execute') {
      once('--execute');
      args.execute = true;
    } else if (a.startsWith('--confirm-dataset=')) {
      once('--confirm-dataset');
      args.confirmDataset = a.slice('--confirm-dataset='.length);
    } else if (a.startsWith('--plan=')) {
      once('--plan');
      args.plan = a.slice('--plan='.length);
    } else args.unknown.push(a);
  }
  return args;
}

/**
 * Operator authorisation – all of it is required; `--execute` alone is never enough.
 * Token policy (fail closed): execution needs BOTH tokens and they must differ. Reads are never done with the write
 * token and the read token can never write – there is no fallback from one to the other.
 */
export function authorizationErrors(args: ExecuteArgs, env: Record<string, string | undefined>, target: Target): string[] {
  const e: string[] = [];
  const readToken = env[MIGRATION_READ_TOKEN_ENV]?.trim();
  const writeToken = env[MIGRATION_WRITE_TOKEN_ENV]?.trim();
  if (args.unknown.length) e.push(`Unknown arguments: ${args.unknown.join(' ')}`);
  if (args.duplicates.length) e.push(`Arguments given more than once: ${args.duplicates.join(' ')}`);
  if (!readToken) e.push(`${MIGRATION_READ_TOKEN_ENV} is not set (Viewer token for the preflight reads; there is no fallback to the write token).`);
  if (!writeToken) e.push(`${MIGRATION_WRITE_TOKEN_ENV} is not set (Editor token for the commit, from the environment only).`);
  if (readToken && writeToken && readToken === writeToken) e.push(`${MIGRATION_READ_TOKEN_ENV} and ${MIGRATION_WRITE_TOKEN_ENV} must be different tokens (Viewer / Editor).`);
  if (!args.execute) e.push('--execute is missing.');
  if (!args.confirmDataset) e.push(`--confirm-dataset=${target.dataset} is missing (acknowledges writing to ${target.projectId}/${target.dataset}).`);
  else if (args.confirmDataset !== target.dataset) e.push(`--confirm-dataset=${args.confirmDataset} does not match the configured dataset "${target.dataset}".`);
  if (!args.plan) e.push('--plan=<fingerprint> is missing – run the preflight and approve its fingerprint.');
  else if (!FINGERPRINT.test(args.plan)) e.push('--plan must be the 64-character fingerprint printed by the preflight.');
  return e;
}

export function approvedTargets(plan: MigrationPlan): ApprovedTargets {
  return {
    create: new Set(plan.projects.filter((p) => p.operation === 'CREATE').map((p) => p.documentId!)),
    update: new Set(plan.projects.filter((p) => p.operation === 'UPDATE').map((p) => p.documentId!)),
  };
}

const TRANSACTION_ID_PREFIX = 'periblugaming-project-migration-';

/**
 * Deterministic transaction ID for an approved plan: the prefix plus the first 32 hex characters (128 bits) of the
 * plan fingerprint – exactly 64 characters, Sanity's maximum (see MAX_TRANSACTION_ID_LENGTH).
 */
export function migrationTransactionId(fingerprint: string): string {
  if (!FINGERPRINT.test(fingerprint)) throw new Error('migrationTransactionId: expected a 64-character plan fingerprint.');
  return `${TRANSACTION_ID_PREFIX}${fingerprint.slice(0, MAX_TRANSACTION_ID_LENGTH - TRANSACTION_ID_PREFIX.length)}`;
}

/** The plan's CREATE/UPDATE operations as one conditional transaction, named after the plan fingerprint. */
export function buildTransaction(plan: MigrationPlan, fingerprint: string): MigrationTransaction {
  const mutations: MigrationTransaction['mutations'] = [];
  for (const p of plan.projects) {
    if (p.operation === 'CREATE') {
      mutations.push({ create: { _id: p.documentId!, _type: 'project', ...p.fields } });
    } else if (p.operation === 'UPDATE') {
      if (!p.existingRev) throw new Error(`UPDATE of ${p.documentId} has no revision – refusing an unconditional write.`);
      const add = Object.fromEntries(p.comparison.filter((c) => c.status === 'add').map((c) => [c.field, c.proposed]));
      mutations.push({ patch: { id: p.documentId!, ifRevisionID: p.existingRev, setIfMissing: add } });
    }
  }
  return { transactionId: migrationTransactionId(fingerprint), mutations };
}

/**
 * - `refused` / `stale` / `nothing-to-do`: decided before the commit – nothing was sent.
 * - `not_committed`: the commit was refused (by Sanity or locally) – the transaction is atomic, nothing was written.
 * - `committed_verified`: Sanity confirmed the commit and the verification read shows every document as intended.
 * - `committed_unverified`: Sanity confirmed the commit, but the verification failed or found a difference/conflict.
 *   The documents may already be live. A fresh preflight is required; nothing is retried.
 * - `unknown`: the commit outcome is unclear (timeout, network, 5xx, unreadable response). Documents may be live.
 *   A fresh preflight is required; nothing is retried.
 */
export type ExecutionStatus = 'refused' | 'stale' | 'nothing-to-do' | 'not_committed' | 'committed_verified' | 'committed_unverified' | 'unknown';

export interface ExecutionResult {
  status: ExecutionStatus;
  messages: string[];
  fingerprint?: string;
  transactionId?: string;
  /** Documents Sanity confirmed as written (committed_*), never guessed. */
  documentIds?: string[];
  /** Documents the transaction was meant to write (set whenever a commit was attempted). */
  plannedDocumentIds?: string[];
  /** Drafts, release versions or other documents the verification found in conflict with written documents. */
  conflicts?: string[];
}

const FRESH_PREFLIGHT = 'Run a fresh preflight (npm run migrate:projects:preflight) and review it before doing anything else – do not re-run execute with the old plan.';

export async function executeMigration(argv: string[], ctx: PreflightContext, log: (line: string) => void = () => {}): Promise<ExecutionResult> {
  let target: Target;
  try {
    target = migrationTarget(ctx.env);
  } catch (err) {
    return { status: 'refused', messages: [err instanceof Error ? err.message : String(err)] };
  }
  const args = parseExecuteArgs(argv);
  const auth = authorizationErrors(args, ctx.env, target);
  if (auth.length) return { status: 'refused', messages: auth };

  log('Gate 2: authenticated preflight …');
  const pre = await authenticatedPreflight(ctx);
  if (pre.blockers.length) return { status: 'refused', messages: pre.blockers, fingerprint: pre.fingerprint };

  log('Gate 3: plan fingerprint …');
  if (pre.fingerprint !== args.plan) {
    return {
      status: 'stale',
      messages: [`The approved plan ${args.plan!.slice(0, 12)}… is not current (now ${pre.fingerprint.slice(0, 12)}…). Run the preflight again and review the new plan.`],
      fingerprint: pre.fingerprint,
    };
  }

  const tx = buildTransaction(pre.plan, pre.fingerprint);
  if (tx.mutations.length === 0) return { status: 'nothing-to-do', messages: ['Every project is UNCHANGED – nothing to write.'], fingerprint: pre.fingerprint };

  log('Gate 4: re-reading the live state immediately before writing …');
  const again = await authenticatedPreflight(ctx);
  if (again.fingerprint !== pre.fingerprint || again.blockers.length) {
    return { status: 'stale', messages: ['The Sanity or GitHub state changed during execution – nothing was written. Run the preflight again.'], fingerprint: again.fingerprint };
  }

  const approved = approvedTargets(pre.plan);
  const planned = [...approved.create, ...approved.update].sort();
  const attempt = { fingerprint: pre.fingerprint, transactionId: tx.transactionId, plannedDocumentIds: planned };

  log(`Gate 5: committing ${tx.mutations.length} conditional mutation(s) in one transaction (${tx.transactionId}) …`);
  let commit;
  try {
    commit = await ctx.adapter.commit(tx, approved);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof MigrationCommitError && err.outcome === 'not_committed') {
      return { status: 'not_committed', messages: [`Not committed: ${reason}. The transaction is atomic – nothing was written. Run the preflight again.`], ...attempt };
    }
    // Anything else – including timeouts – is NOT a confirmed failure.
    return {
      status: 'unknown',
      messages: [
        `Outcome unknown: ${reason}.`,
        `Transaction ${tx.transactionId} may or may not have been committed (it is atomic: either all of ${planned.join(', ')} were written or none).`,
        'The documents may already be live. Nothing is retried automatically.',
        FRESH_PREFLIGHT,
      ],
      ...attempt,
    };
  }

  // From here on the commit is confirmed by Sanity. Whatever happens, the result says so.
  const committed = { ...attempt, transactionId: commit.transactionId, documentIds: [...commit.documentIds].sort() };
  const unverified = (problems: string[], conflicts: string[] = []): ExecutionResult => ({
    status: 'committed_unverified',
    messages: [
      `COMMITTED but NOT VERIFIED: Sanity confirmed transaction ${commit.transactionId} for ${committed.documentIds.join(', ') || '(no IDs returned)'}.`,
      ...problems.map((p) => `- ${p}`),
      'The documents may already be live (the next deploy publishes them). Nothing is retried automatically.',
      FRESH_PREFLIGHT,
    ],
    ...committed,
    ...(conflicts.length && { conflicts }),
  });

  log('Verifying …');
  const problems: string[] = [];
  const returned = new Set(commit.documentIds);
  const unexpected = commit.documentIds.filter((id) => !planned.includes(id));
  const notReturned = planned.filter((id) => !returned.has(id));
  if (unexpected.length) problems.push(`Sanity reported unexpected document IDs: ${unexpected.join(', ')}`);
  if (notReturned.length) problems.push(`Sanity did not report these planned documents: ${notReturned.join(', ')}`);

  let after: Preflight;
  try {
    after = await authenticatedPreflight(ctx);
  } catch (err) {
    return unverified([...problems, `The verification read failed: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const byId = new Map(after.plan.projects.filter((p) => p.documentId).map((p) => [p.documentId!, p]));
  const conflicts = new Set<string>();
  for (const id of planned) {
    const p = byId.get(id);
    if (!p) problems.push(`${id} is not part of the verification plan.`);
    else if (p.operation !== 'UNCHANGED') {
      problems.push(`${id} is ${p.operation}${p.reasons.length ? `: ${p.reasons.join(' ')}` : ''}`);
      for (const c of p.conflictingDocuments ?? []) conflicts.add(c);
    }
  }
  if (conflicts.size) problems.push(`Conflicting documents (review them in the Studio; nothing was changed or deleted): ${[...conflicts].sort().join(', ')}`);
  if (problems.length) return unverified(problems, [...conflicts].sort());

  return { status: 'committed_verified', messages: ['Committed and verified: every migrated document is now UNCHANGED.'], ...committed };
}
