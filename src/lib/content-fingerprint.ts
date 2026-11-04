/**
 * Fingerprint of the Sanity content that is visible on the website.
 *
 * Every visible document contributes its type, ID and revision. `_rev` changes with every publish, so the
 * fingerprint changes when a document is published, edited, unpublished or deleted – and when a scheduled post
 * becomes visible (it enters the set). Because the revision covers the whole published document, every field that
 * can affect the site is included without listing fields (for projects e.g. featured/order/hidden, and the
 * screenshot's asset reference, alt text, hotspot and crop). Drafts and release versions never contribute: they are
 * read with the "published" perspective and excluded by each source's filter.
 *
 * The build computes it from exactly the documents it rendered and publishes it in /build-info.json; the scheduled
 * deploy check computes it from a live query and compares (see src/lib/deploy-check.ts).
 *
 * Runs in Astro and in plain Node (`node scripts/deploy-check.ts`) – no runtime dependencies.
 */
import { createHash } from 'node:crypto';
import { POST_VISIBLE_FILTER } from './blog/visibility.ts';
import { PROJECT_DOCUMENT_FILTER } from './project-visibility.ts';

/**
 * Bump when the hashing scheme or the sources change in a way old fingerprints can't be compared with.
 * The deploy check rebuilds once when the live build info has another version.
 * 1: posts. 2: posts + projects.
 */
export const FINGERPRINT_VERSION = 2;

export interface ContentSource {
  /** Document type, e.g. "post". */
  type: string;
  /** GROQ filter selecting the documents of this type that are visible on the website. */
  filter: string;
}

/**
 * All Sanity content the website renders. When a new type is rendered, add it here with its visibility filter AND
 * contribute its fetched documents to the build fingerprint (buildContentFingerprint, src/pages/build-info.json.ts).
 */
export const contentSources: readonly ContentSource[] = [
  { type: 'post', filter: POST_VISIBLE_FILTER },
  { type: 'project', filter: PROJECT_DOCUMENT_FILTER },
];

export interface ContentItem {
  _type: string;
  _id: string;
  _rev: string;
}

export interface ContentFingerprint {
  version: number;
  /** Source types included, sorted. */
  types: string[];
  count: number;
  /** sha256 hex. */
  hash: string;
}

export class FingerprintError extends Error {
  constructor(message: string) {
    super(`[fingerprint] ${message}`);
    this.name = 'FingerprintError';
  }
}

/** GROQ query returning type, ID and revision of every visible document of all sources. */
export function fingerprintQuery(sources: readonly ContentSource[] = contentSources): string {
  if (sources.length === 0) throw new FingerprintError('no content sources configured.');
  return `*[${sources.map((s) => `(${s.filter})`).join(' || ')}]{_type, _id, _rev}`;
}

const isItem = (v: unknown): v is ContentItem =>
  typeof v === 'object' &&
  v !== null &&
  ['_type', '_id', '_rev'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string' && (v as Record<string, string>)[k] !== '');

export function computeFingerprint(items: unknown, sources: readonly ContentSource[] = contentSources): ContentFingerprint {
  if (!Array.isArray(items)) throw new FingerprintError('expected an array of documents.');
  const types = [...new Set(sources.map((s) => s.type))].sort();

  const lines = items.map((item, i) => {
    if (!isItem(item)) throw new FingerprintError(`document #${i} has no valid _type/_id/_rev.`);
    if (!types.includes(item._type)) throw new FingerprintError(`document ${item._id} has unexpected type "${item._type}".`);
    return `${item._type}\t${item._id}\t${item._rev}`;
  });
  if (new Set(lines.map((l) => l.split('\t', 2).join('\t'))).size !== lines.length) {
    throw new FingerprintError('duplicate document IDs.');
  }

  const hash = createHash('sha256')
    .update(`v${FINGERPRINT_VERSION}\n${types.join(',')}\n${lines.sort().join('\n')}`)
    .digest('hex');
  return { version: FINGERPRINT_VERSION, types, count: lines.length, hash };
}

/** What the build loaded from Sanity, per source (see src/lib/blog/load.ts and src/lib/project-data.ts). */
export interface BuildContent {
  blog: { status: string; contentItems?: ContentItem[] };
  projects: { overrides: string; contentItems?: ContentItem[] };
}

/**
 * Fingerprint of everything the build rendered from Sanity – only if every source was loaded from Sanity.
 * If a source fell back (Sanity not configured, unavailable, invalid response), there is no fingerprint: an
 * incomplete one would look like deleted content, the next check would rebuild, and a lasting failure would deploy
 * every 15 minutes. Without a fingerprint the workflow's `built` step refuses to deploy instead.
 */
export function buildContentFingerprint(build: BuildContent): { content: ContentFingerprint | null; reason?: string } {
  if (build.blog.status !== 'sanity') return { content: null, reason: `blog not loaded from Sanity (status "${build.blog.status}")` };
  if (build.projects.overrides !== 'sanity') {
    return { content: null, reason: `project documents not loaded from Sanity (status "${build.projects.overrides}")` };
  }
  return { content: computeFingerprint([...(build.blog.contentItems ?? []), ...(build.projects.contentItems ?? [])]) };
}
