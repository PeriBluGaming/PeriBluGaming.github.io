/**
 * Sanity access for the controlled project migration (scripts/sanity-project-migration.ts). The ONLY module of the
 * migration that can write. Plain HTTP API via fetch (no extra dependency, no asset upload code at all).
 *
 * Writes are restricted twice: assertSafeTransaction() only lets `create` (fails if the document exists) and
 * `patch` with `ifRevisionID` + `setIfMissing` (fails on concurrent edits, only adds missing fields) through, for
 * project documents the approved plan names – checked locally before anything is sent. All mutations of a run go into
 * one Sanity transaction, which is atomic. Tokens are sent only in the Authorization header and never logged.
 */

export interface RawSanityDoc {
  _id: string;
  _type: string;
  _rev?: string;
  [field: string]: unknown;
}

export type MigrationMutation =
  | { create: { _id: string; _type: 'project'; [field: string]: unknown } }
  | { patch: { id: string; ifRevisionID: string; setIfMissing: Record<string, unknown> } };

export interface MigrationTransaction {
  transactionId: string;
  mutations: MigrationMutation[];
}

export interface CommitResult {
  transactionId: string;
  documentIds: string[];
}

/**
 * Why a commit did not return a confirmed result:
 * - `not_committed`: Sanity refused the transaction (4xx – e.g. a document now exists, a revision changed) or it was
 *   never sent (no write token, unsafe transaction). The transaction is atomic, so nothing was written.
 * - `unknown`: the outcome is unclear (network error, timeout, 5xx, redirect, unreadable 2xx body). Documents MAY be
 *   live – never retry automatically; run a fresh preflight.
 */
export type CommitFailure = 'not_committed' | 'unknown';

export class MigrationCommitError extends Error {
  readonly outcome: CommitFailure;
  constructor(outcome: CommitFailure, message: string) {
    super(message);
    this.name = 'MigrationCommitError';
    this.outcome = outcome;
  }
}

/** Document IDs the approved plan allows to create / update. */
export interface ApprovedTargets {
  create: ReadonlySet<string>;
  update: ReadonlySet<string>;
}

export interface SanityMigrationAdapter {
  /** All `project` documents in the raw perspective: published, drafts and release versions. */
  listProjectDocuments(): Promise<RawSanityDoc[]>;
  /** Documents of any type whose ID is one of `ids`, or a draft / release version of one. */
  findDocumentsByBaseIds(ids: string[]): Promise<RawSanityDoc[]>;
  findAssetsBySha1(hashes: string[]): Promise<{ _id: string; sha1hash: string }[]>;
  /**
   * The exact stored documents with these IDs (doc endpoint, no GROQ projection): an explicit `null` stays `null`,
   * a missing field stays missing. Throws if one of them does not exist.
   */
  getDocuments(ids: string[]): Promise<RawSanityDoc[]>;
  /** Must call assertSafeTransaction(transaction, approved) before sending anything. */
  commit(transaction: MigrationTransaction, approved: ApprovedTargets): Promise<CommitResult>;
}

/** Sanity rejects longer transaction IDs with HTTP 400 ("too long (must be at most 64 characters)"). */
export const MAX_TRANSACTION_ID_LENGTH = 64;
const TRANSACTION_ID_PATTERN = new RegExp(`^[A-Za-z0-9._-]{1,${MAX_TRANSACTION_ID_LENGTH}}$`);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIGRATED_FIELD_NAMES = new Set(['repo', 'title', 'description', 'category', 'tags', 'hidden', 'featured', 'featuredOrder', 'accent']);

/**
 * Throws unless every mutation is an allowed, plan-approved write. Called by every adapter before sending.
 * Allowed: create (new project document, migrated fields only) and conditional setIfMissing patches.
 */
export function assertSafeTransaction(tx: MigrationTransaction, approved: ApprovedTargets): void {
  if (!TRANSACTION_ID_PATTERN.test(tx.transactionId)) {
    throw new Error(`unsafe transaction: invalid transaction ID (letters, digits, . _ - only; at most ${MAX_TRANSACTION_ID_LENGTH} characters)`);
  }
  if (tx.mutations.length === 0) throw new Error('unsafe transaction: no mutations');
  const seen = new Set<string>();
  for (const m of tx.mutations) {
    const kinds = Object.keys(m);
    if (kinds.length !== 1) throw new Error('unsafe transaction: one operation per mutation');
    const kind = kinds[0];
    if (kind === 'create') {
      const doc = (m as { create: RawSanityDoc }).create;
      const extra = Object.keys(doc).filter((k) => k !== '_id' && k !== '_type' && !MIGRATED_FIELD_NAMES.has(k));
      if (doc._type !== 'project' || !PROJECT_ID_PATTERN.test(doc._id) || /^(drafts|versions)\./.test(doc._id)) {
        throw new Error(`unsafe transaction: create must target a published project document (got ${doc._type} ${doc._id})`);
      }
      if (extra.length) throw new Error(`unsafe transaction: create contains non-migrated fields (${extra.join(', ')})`);
      if (!approved.create.has(doc._id)) throw new Error(`unsafe transaction: ${doc._id} is not an approved CREATE`);
      if (seen.has(doc._id)) throw new Error(`unsafe transaction: ${doc._id} appears twice`);
      seen.add(doc._id);
    } else if (kind === 'patch') {
      const patch = (m as { patch: Record<string, unknown> }).patch;
      const keys = Object.keys(patch).sort().join(',');
      if (keys !== 'id,ifRevisionID,setIfMissing') throw new Error(`unsafe transaction: patch may only use id, ifRevisionID, setIfMissing (got ${keys})`);
      const id = String(patch.id);
      const fields = Object.keys(patch.setIfMissing as object);
      if (!patch.ifRevisionID || typeof patch.ifRevisionID !== 'string') throw new Error(`unsafe transaction: patch of ${id} without ifRevisionID`);
      if (!fields.length || fields.some((f) => !MIGRATED_FIELD_NAMES.has(f))) throw new Error(`unsafe transaction: patch of ${id} touches non-migrated fields`);
      if (!approved.update.has(id)) throw new Error(`unsafe transaction: ${id} is not an approved UPDATE`);
      if (seen.has(id)) throw new Error(`unsafe transaction: ${id} appears twice`);
      seen.add(id);
    } else {
      throw new Error(`unsafe transaction: operation "${kind}" is not allowed (only create and conditional setIfMissing patches)`);
    }
  }
}

const LIST_PROJECTS_QUERY = /* groq */ `*[_type == "project"] | order(_id asc) {
  _id, _type, _rev, repo, title, description, category, tags, hidden, featured, featuredOrder, accent,
  "screenshots": screenshots[]{ alt, "assetRef": asset._ref }
}`;
const BY_IDS_QUERY = /* groq */ `*[_id in $ids || _id in $draftIds || _id in path("versions.**")] | order(_id asc) { _id, _type, _rev, repo }`;
const ASSETS_QUERY = /* groq */ `*[_type == "sanity.imageAsset" && sha1hash in $hashes] | order(_id asc) { _id, sha1hash }`;

const versionBase = (id: string) => /^versions\.[^.]+\.(.+)$/.exec(id)?.[1];

/**
 * Real adapter: Sanity HTTP API (raw perspective for reads; one atomic transaction for writes).
 *
 * - `readToken` (required) is used for every read; `writeToken` (optional) ONLY for the mutate request. Without a
 *   write token, commit() refuses before sending anything – the preflight adapter is created without one.
 * - Every request uses `redirect: 'error'`: a redirect is never followed, so a token cannot be forwarded elsewhere.
 * - Tokens are sent only in the Authorization header and redacted from every error message.
 */
export function createHttpAdapter(options: {
  projectId: string;
  dataset: string;
  apiVersion: string;
  readToken: string;
  writeToken?: string;
  fetchImpl?: typeof fetch;
}): SanityMigrationAdapter {
  const { projectId, dataset, apiVersion, readToken, writeToken } = options;
  if (!readToken) throw new Error('A read token is required for the authenticated migration reads.');
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `https://${projectId}.api.sanity.io/v${apiVersion}/data`;
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'periblugaming-project-migration' });
  const secrets = [readToken, writeToken].filter((t): t is string => Boolean(t));
  const redact = (text: string) => secrets.reduce((t, secret) => t.split(secret).join('***'), text);
  const describe = (err: unknown) =>
    redact(err instanceof Error ? `${err.message}${err.cause instanceof Error ? ` (${err.cause.message})` : ''}` : String(err));

  async function read(url: URL): Promise<unknown> {
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: headers(readToken), redirect: 'error', signal: AbortSignal.timeout(20_000) });
      text = await res.text();
    } catch (err) {
      throw new Error(`Sanity read failed: ${describe(err)}`);
    }
    if (!res.ok) throw new Error(redact(`Sanity read failed: HTTP ${res.status} ${text.slice(0, 200)}`));
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Sanity read returned a response that is not JSON.');
    }
  }

  async function query<T>(groq: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = new URL(`${base}/query/${dataset}`);
    url.searchParams.set('query', groq);
    url.searchParams.set('perspective', 'raw');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`$${k}`, JSON.stringify(v));
    const body = (await read(url)) as { result?: unknown } | null;
    if (!Array.isArray(body?.result)) throw new Error('Sanity query returned an unexpected response.');
    return body.result as T;
  }

  return {
    listProjectDocuments: () => query<RawSanityDoc[]>(LIST_PROJECTS_QUERY),
    async findDocumentsByBaseIds(ids) {
      const docs = await query<RawSanityDoc[]>(BY_IDS_QUERY, { ids, draftIds: ids.map((id) => `drafts.${id}`) });
      const wanted = new Set(ids);
      return docs.filter((d) => !d._id.startsWith('versions.') || wanted.has(versionBase(d._id) ?? ''));
    },
    findAssetsBySha1: (hashes) => (hashes.length ? query(ASSETS_QUERY, { hashes }) : Promise.resolve([])),
    async getDocuments(ids) {
      if (ids.length === 0) return [];
      if (ids.some((id) => !PROJECT_ID_PATTERN.test(id))) throw new Error('getDocuments: invalid document ID.');
      const body = (await read(new URL(`${base}/doc/${dataset}/${ids.join(',')}`))) as { documents?: unknown } | null;
      const docs = body?.documents;
      if (!Array.isArray(docs) || docs.some((d) => typeof d !== 'object' || d === null || typeof (d as RawSanityDoc)._id !== 'string')) {
        throw new Error('Sanity doc endpoint returned an unexpected response.');
      }
      const found = new Set((docs as RawSanityDoc[]).map((d) => d._id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) throw new Error(`Documents disappeared while reading: ${missing.join(', ')} – run the preflight again.`);
      return docs as RawSanityDoc[];
    },
    async commit(tx, approved) {
      if (!writeToken) throw new MigrationCommitError('not_committed', 'no write token configured – nothing was sent');
      try {
        assertSafeTransaction(tx, approved);
      } catch (err) {
        throw new MigrationCommitError('not_committed', `${err instanceof Error ? err.message : String(err)} – nothing was sent`);
      }
      const url = new URL(`${base}/mutate/${dataset}`);
      url.searchParams.set('returnIds', 'true');
      url.searchParams.set('visibility', 'sync');
      let res: Response;
      let text: string;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { ...headers(writeToken), 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactionId: tx.transactionId, mutations: tx.mutations }),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
        text = redact(await res.text());
      } catch (err) {
        // Includes timeouts and refused redirects: the request may have reached Sanity – NOT a confirmed failure.
        throw new MigrationCommitError('unknown', `no complete response from Sanity (${describe(err)})`);
      }
      if (res.status >= 500 || (res.status >= 300 && res.status < 400)) {
        throw new MigrationCommitError('unknown', `Sanity answered HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      if (!res.ok) throw new MigrationCommitError('not_committed', `Sanity rejected the transaction (HTTP ${res.status}): ${text.slice(0, 300)}`);
      let body: { transactionId?: unknown; results?: unknown } | null;
      try {
        body = JSON.parse(text);
      } catch {
        throw new MigrationCommitError('unknown', `Sanity answered HTTP ${res.status} with a body that is not JSON`);
      }
      const results = body?.results;
      if (
        typeof body?.transactionId !== 'string' ||
        !Array.isArray(results) ||
        results.some((r) => typeof r !== 'object' || r === null || typeof (r as { id?: unknown }).id !== 'string')
      ) {
        throw new MigrationCommitError('unknown', `Sanity answered HTTP ${res.status} with an unexpected body`);
      }
      return { transactionId: body.transactionId, documentIds: (results as { id: string }[]).map((r) => r.id) };
    },
  };
}
