/**
 * DRY RUN ONLY – plans how the local project configuration (src/config/projects.ts) would become Sanity `project`
 * documents. Pure: no network, no file system, no Sanity client. The plan is a report, not an executable instruction:
 * it contains no mutations, no credentials and no image references that would need an upload.
 *
 * GitHub stays authoritative for repository identity; documents are only proposed for repositories in the GitHub
 * inventory. The effect on the website is checked with the real merge (src/lib/project-merge.ts).
 */
import { createHash } from 'node:crypto';
import type { Accent, CategoryId, ProjectImage } from '../config/projects.ts';
import type { RepoData } from './github.ts';
import {
  mergeProjects,
  normalizeSanityProject,
  repoKey,
  selectOverrides,
  type EditorialOverride,
  type FeaturedProject,
  type MergeConfig,
  type Project,
} from './project-merge.ts';

export const PLAN_KIND = 'periblugaming.sanity-project-migration.dry-run';

/** Intentional additions that are not (yet) in src/config/projects.ts. */
export interface ProposedAddition {
  repo: string;
  title: string;
  description: string;
  category: CategoryId;
  tags: string[];
  featured: true;
  accent: Accent;
  /** 0-based position in the featured list after the migration; later entries shift by one. Default: at the end. */
  featuredPosition?: number;
  /** Where the values come from. */
  source: string;
}

/**
 * SledStormPSXRecomp – values from the WIP stash on docs/extend-projects (stash@{0}, base 3a28e7e), verified read-only.
 * Featured as 4th entry, as in the stash (decided by the owner); the entries after it shift by one.
 */
export const MIGRATION_ADDITIONS: readonly ProposedAddition[] = [
  {
    repo: 'SledStormPSXRecomp',
    title: 'Sled Storm PSX Recomp',
    description: 'Native recompilation of Sled Storm for the PlayStation into a modern PC executable.',
    category: 'playstation',
    tags: ['PS1', 'Recomp'],
    featured: true,
    accent: 'cyan',
    featuredPosition: 3,
    source: 'stash@{0} "WIP: extend projects before Sanity setup" (docs/extend-projects, base 3a28e7e)',
  },
];

/** Editorial fields a migration may set, in report order. Screenshots are never written by this plan. */
export const MIGRATED_FIELDS = ['repo', 'title', 'description', 'category', 'tags', 'hidden', 'featured', 'featuredOrder', 'accent'] as const;
export type MigratedField = (typeof MIGRATED_FIELDS)[number];
export type ProposedFields = Partial<Record<MigratedField, unknown>> & { repo: string };

export interface ExistingProjectDoc {
  _id: string;
  /** Revision (authenticated reads); used as a precondition for updates. */
  _rev?: string;
  repo?: unknown;
  title?: unknown;
  description?: unknown;
  category?: unknown;
  tags?: unknown;
  hidden?: unknown;
  featured?: unknown;
  featuredOrder?: unknown;
  accent?: unknown;
  screenshots?: { alt?: unknown; assetRef?: unknown }[] | null;
}

/**
 * Documents only an authenticated read can see, or that are not published project documents: drafts and release
 * versions (`drafts.*`, `versions.<release>.*`) of projects, and documents of any type that occupy a proposed ID.
 */
export interface RelatedDoc {
  _id: string;
  _type: string;
  _rev?: string;
  repo?: unknown;
}

export interface LocalScreenshot {
  repo: string;
  path: string;
  exists: boolean;
  alt: string;
  position: string;
  sha1: string | null;
  /** Sanity image asset with the same SHA-1, if one exists. */
  sanityAssetId: string | null;
}

export type Operation = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP' | 'BLOCKED';
export type FieldStatus = 'same' | 'add' | 'keep' | 'conflict';

export interface FieldComparison {
  field: MigratedField;
  existing: unknown;
  proposed: unknown;
  status: FieldStatus;
}

export type ScreenshotStatus =
  | { kind: 'none'; note: string }
  | { kind: 'missing-file'; local: LocalScreenshot; note: string }
  | { kind: 'upload-required'; local: LocalScreenshot; note: string }
  | { kind: 'asset-exists'; local: LocalScreenshot; note: string }
  | { kind: 'in-sanity'; local: LocalScreenshot | null; note: string };

export interface ProjectProposal {
  repo: string;
  /** Proposed (or existing) Sanity document ID; null when skipped. */
  documentId: string | null;
  operation: Operation;
  reasons: string[];
  /** Values the document would have after the migration (existing values are kept). */
  fields: ProposedFields;
  comparison: FieldComparison[];
  origin: 'configuration' | 'addition';
  screenshot: ScreenshotStatus;
  /** Revision of the existing document (precondition for an UPDATE). */
  existingRev?: string;
  /** Drafts, release versions or other documents that block this project (IDs). */
  conflictingDocuments?: string[];
}

export interface CardSnapshot {
  name: string;
  title: string;
  description: string | null;
  category: string;
  tags: string[];
  featured: boolean;
  accent: string | null;
  image: string | null;
}

export interface CompatibilityReport {
  currentFeatured: string[];
  proposedFeatured: string[];
  differences: { name: string; field: string; current: unknown; proposed: unknown; intended: boolean }[];
  /** Featured positions (0-based) that change. Intended when only additions were inserted (relative order kept). */
  positionChanges: { name: string; current: number | null; proposed: number | null; intended: boolean }[];
  added: string[];
  removed: string[];
}

export interface MigrationPlan {
  kind: typeof PLAN_KIND;
  dryRun: true;
  /** Never true – nothing in this plan can be executed against Sanity. */
  executable: false;
  sources: { github: string; sanity: string; schemaValidation: string };
  summary: {
    githubRepositories: number;
    configuredProjects: number;
    existingSanityDocuments: number;
    operations: Record<Operation, number>;
    screenshotUploads: number;
  };
  projects: ProjectProposal[];
  untouchedSanityDocuments: string[];
  missingRepositories: string[];
  compatibility: CompatibilityReport;
  notes: string[];
  /** Inputs that determine the plan (for the plan fingerprint): repository names and documents with revisions. */
  state: { repositories: string[]; documents: string[]; draftsChecked: boolean };
}

export interface PlanInput {
  config: MergeConfig;
  repos: RepoData[];
  githubSource: string;
  existing: ExistingProjectDoc[];
  /** Drafts, release versions and ID-occupying documents (authenticated preflight only). Absent = not checked. */
  related?: RelatedDoc[];
  sanitySource: string;
  screenshots: LocalScreenshot[];
  additions?: readonly ProposedAddition[];
  /** Errors from the Studio schema validation per proposed document ID, or null if it could not run. */
  schemaErrors?: Map<string, string[]> | null;
  schemaValidation?: string;
  resolveLocalImage: (image: ProjectImage, repo: string) => ProjectImage;
}

/** Deterministic Sanity document ID for a repository: `project-` + lowercase name, other characters → "-". */
export function documentIdForRepo(repo: string): string {
  const slug = repoKey(repo).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Cannot derive a document ID from repository name "${repo}".`);
  return `project-${slug}`.slice(0, 128);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `drafts.x` / `versions.<release>.x` → `x`. */
export function baseDocumentId(id: string): string {
  if (id.startsWith('drafts.')) return id.slice('drafts.'.length);
  const version = /^versions\.[^.]+\.(.+)$/.exec(id);
  return version ? version[1] : id;
}
const defined = (v: unknown) => v !== undefined && v !== null;

/** Editorial values from the local configuration (+ intended additions), keyed by normalised repository name. */
export function proposeFields(config: MergeConfig, additions: readonly ProposedAddition[]) {
  const proposals = new Map<string, { fields: ProposedFields; origin: ProjectProposal['origin'] }>();
  const localName = new Map<string, string>();
  for (const name of Object.keys(config.projectOverrides)) localName.set(repoKey(name), name);
  for (const f of config.featuredProjects) if (!localName.has(repoKey(f.repo))) localName.set(repoKey(f.repo), f.repo);

  const overrides = new Map(Object.entries(config.projectOverrides).map(([n, o]) => [repoKey(n), o]));
  const featured = new Map(config.featuredProjects.map((f) => [repoKey(f.repo), f]));

  // Final featured order: the configured entries in their order, additions inserted at their position.
  const order = config.featuredProjects.map((f) => repoKey(f.repo));
  for (const a of additions) {
    const at = a.featuredPosition ?? order.length;
    if (!Number.isInteger(at) || at < 0 || at > order.length) throw new Error(`Invalid featuredPosition ${at} for "${a.repo}".`);
    order.splice(at, 0, repoKey(a.repo));
  }
  const featuredOrder = new Map(order.map((k, i) => [k, i]));

  for (const [k, name] of localName) {
    const o = overrides.get(k) ?? {};
    const f = featured.get(k);
    const fields: ProposedFields = { repo: name };
    if (o.title !== undefined) fields.title = o.title;
    if (o.description !== undefined) fields.description = o.description;
    if (o.category !== undefined) fields.category = o.category;
    if (o.tags !== undefined) fields.tags = [...o.tags];
    fields.hidden = o.hidden ?? false;
    if (f) {
      fields.featured = true;
      fields.featuredOrder = featuredOrder.get(k);
      fields.accent = f.accent;
    }
    proposals.set(k, { fields, origin: 'configuration' });
  }

  for (const a of additions) {
    const k = repoKey(a.repo);
    if (proposals.has(k)) throw new Error(`Addition "${a.repo}" is already configured – merge it explicitly instead.`);
    proposals.set(k, {
      fields: {
        repo: a.repo, title: a.title, description: a.description, category: a.category, tags: [...a.tags],
        hidden: false, featured: true, featuredOrder: featuredOrder.get(k), accent: a.accent,
      },
      origin: 'addition',
    });
  }
  return proposals;
}

function compare(existing: ExistingProjectDoc | undefined, proposed: ProposedFields): FieldComparison[] {
  return MIGRATED_FIELDS.flatMap((field): FieldComparison[] => {
    const e = existing?.[field];
    const p = proposed[field];
    if (!defined(e) && !defined(p)) return [];
    // An explicitly stored null is a value, not a missing field: whether `setIfMissing` would replace it is not
    // guaranteed, so it is never touched automatically – manual review instead.
    if (e === null) return [{ field, existing: null, proposed: p, status: 'conflict' }];
    const status: FieldStatus = !defined(e) ? 'add' : !defined(p) ? 'keep' : same(e, p) ? 'same' : field === 'repo' && repoKey(String(e)) === repoKey(String(p)) ? 'same' : 'conflict';
    return [{ field, existing: e, proposed: p, status }];
  });
}

function screenshotStatus(local: LocalScreenshot | undefined, existing: ExistingProjectDoc | undefined): ScreenshotStatus {
  const inSanity = Array.isArray(existing?.screenshots) && existing.screenshots.length > 0;
  if (inSanity) return { kind: 'in-sanity', local: local ?? null, note: 'Sanity document already has screenshots – not touched.' };
  if (!local) return { kind: 'none', note: 'No local screenshot – the card keeps its platform artwork.' };
  if (!local.exists) return { kind: 'missing-file', local, note: `Configured file is missing: public${local.path}.` };
  const fallback = 'Local fallback stays effective (the document gets no screenshot).';
  if (local.sanityAssetId) {
    return { kind: 'asset-exists', local, note: `Identical Sanity asset exists (${local.sanityAssetId}); can be referenced in a later step. ${fallback}` };
  }
  return { kind: 'upload-required', local, note: `Pending: upload to Sanity required before it can be referenced. ${fallback}` };
}

const snapshot = (p: Project | FeaturedProject): CardSnapshot => ({
  name: p.name,
  title: p.title,
  description: p.description,
  category: p.category.id,
  tags: p.tags,
  featured: p.featured,
  accent: 'accent' in p ? p.accent : null,
  image: 'image' in p && p.image ? p.image.src : null,
});

/** Website rendering for a set of Sanity documents, with the real merge. */
function render(input: PlanInput, docs: ExistingProjectDoc[]) {
  const categoryIds = new Set(input.config.categories.map((c) => c.id));
  const valid: EditorialOverride[] = [];
  for (const d of docs) {
    const { override } = normalizeSanityProject({ ...d, screenshot: null }, { categoryIds, resolveImage: () => null });
    if (override) valid.push(override);
  }
  const { featured, all } = mergeProjects({ repos: input.repos, overrides: selectOverrides(valid).byKey, config: input.config, resolveLocalImage: input.resolveLocalImage });
  const cards = new Map<string, CardSnapshot>();
  for (const p of all) cards.set(p.name, snapshot(p));
  for (const p of featured) cards.set(p.name, snapshot(p)); // featured carries accent + image
  return { featured: featured.map((p) => p.name), cards };
}

export function planMigration(input: PlanInput): MigrationPlan {
  const additions = input.additions ?? MIGRATION_ADDITIONS;
  const proposals = proposeFields(input.config, additions);
  const notes: string[] = [];
  const githubByKey = new Map(input.repos.map((r) => [repoKey(r.name), r]));
  const excluded = new Set(input.config.listSettings.exclude.map(repoKey));
  const categoryIds = new Set(input.config.categories.map((c) => c.id));
  const localShots = new Map(input.screenshots.map((s) => [repoKey(s.repo), s]));

  const existingByKey = new Map<string, ExistingProjectDoc[]>();
  for (const d of input.existing) {
    const k = typeof d.repo === 'string' ? repoKey(d.repo) : `?${d._id}`;
    existingByKey.set(k, [...(existingByKey.get(k) ?? []), d]);
  }
  const existingIds = new Map(input.existing.map((d) => [d._id, d]));

  // Deterministic IDs must not collide between different repositories.
  const idOwners = new Map<string, string[]>();
  for (const k of proposals.keys()) {
    const id = documentIdForRepo(k);
    idOwners.set(id, [...(idOwners.get(id) ?? []), k]);
  }

  const projects: ProjectProposal[] = [];
  const missingRepositories: string[] = [];

  for (const [k, { fields: proposed, origin }] of proposals) {
    const reasons: string[] = [];
    const repo = githubByKey.get(k);
    const existingDocs = existingByKey.get(k) ?? [];
    const existing = existingDocs.length === 1 ? existingDocs[0] : undefined;
    const screenshot = screenshotStatus(localShots.get(k), existing);
    const base = { origin, screenshot } as const;

    if (!repo) {
      missingRepositories.push(proposed.repo);
      projects.push({ ...base, repo: proposed.repo, documentId: null, operation: 'SKIP', reasons: [`Not in the GitHub inventory (${input.githubSource}).`], fields: proposed, comparison: [] });
      continue;
    }
    if (excluded.has(k)) {
      projects.push({ ...base, repo: repo.name, documentId: null, operation: 'SKIP', reasons: ['Excluded by listSettings.exclude.'], fields: proposed, comparison: [] });
      continue;
    }
    // GitHub owns the repository name.
    const fields: ProposedFields = { ...proposed, repo: repo.name };
    const proposedId = documentIdForRepo(repo.name);

    let operation: Operation;
    let documentId: string | null = existing?._id ?? proposedId;
    const comparison = compare(existing, fields);
    const targetIds = new Set([proposedId, ...(existing ? [existing._id] : [])]);
    const related = (input.related ?? []).filter(
      (d) => targetIds.has(baseDocumentId(d._id)) || (d._type === 'project' && typeof d.repo === 'string' && repoKey(d.repo) === k),
    );

    if (existingDocs.length > 1) {
      operation = 'BLOCKED';
      reasons.push(`Duplicate Sanity documents for this repository: ${existingDocs.map((d) => d._id).sort().join(', ')}. Resolve manually.`);
      documentId = null;
    } else if (related.length > 0) {
      operation = 'BLOCKED';
      reasons.push(
        `Unpublished or conflicting documents: ${related.map((d) => `${d._id} (${d._type})`).sort().join(', ')}. ` +
          'Publish or discard drafts / release versions in the Studio, or resolve the ID conflict, then run the preflight again.',
      );
    } else if ((idOwners.get(proposedId) ?? []).length > 1) {
      operation = 'BLOCKED';
      reasons.push(`Document ID ${proposedId} would be shared by: ${idOwners.get(proposedId)!.join(', ')}.`);
    } else if (!existing && existingIds.has(proposedId)) {
      operation = 'BLOCKED';
      reasons.push(`Document ID ${proposedId} is already used by another repository (${String(existingIds.get(proposedId)!.repo)}).`);
    } else if (comparison.some((c) => c.status === 'conflict')) {
      operation = 'BLOCKED';
      reasons.push(`Editorial conflict with ${existing!._id}: ${comparison.filter((c) => c.status === 'conflict').map((c) => (c.existing === null ? `${c.field} (stored null)` : c.field)).join(', ')} – manual review required, nothing is overwritten.`);
    } else if (!existing) {
      operation = 'CREATE';
    } else if (comparison.some((c) => c.status === 'add')) {
      operation = 'UPDATE';
      reasons.push(`Adds missing fields only: ${comparison.filter((c) => c.status === 'add').map((c) => c.field).join(', ')}.`);
    } else {
      operation = 'UNCHANGED';
    }
    if (existing && existing._id !== proposedId) reasons.push(`Existing document ID ${existing._id} is kept (no duplicate under ${proposedId}).`);

    // Values after the migration: existing values win (never overwritten), missing ones are added.
    const after: ProposedFields = { ...fields };
    if (existing) for (const c of comparison) if (c.status === 'keep' || c.status === 'conflict') (after as Record<string, unknown>)[c.field] = c.existing;

    // The website must accept every proposed value; the Studio schema must too (if it could be checked).
    const { warnings } = normalizeSanityProject({ _id: documentId ?? proposedId, ...fields }, { categoryIds, resolveImage: () => null });
    const schema = input.schemaErrors?.get(proposedId) ?? [];
    if (operation !== 'BLOCKED' && (warnings.length > 0 || schema.length > 0)) {
      operation = 'BLOCKED';
    }
    reasons.push(...warnings.map((w) => `Website validation: ${w}`), ...schema.map((e) => `Schema validation: ${e}`));

    projects.push({
      ...base, repo: repo.name, documentId, operation, reasons, fields: after, comparison,
      ...(existing?._rev && { existingRev: existing._rev }),
      ...(related.length > 0 && { conflictingDocuments: related.map((d) => d._id).sort() }),
    });
  }

  // Featured first in their order, then by repository name – stable across runs.
  const order = (p: ProjectProposal) => (p.fields.featured === true && typeof p.fields.featuredOrder === 'number' ? p.fields.featuredOrder : Infinity);
  projects.sort((a, b) => (order(a) === order(b) ? 0 : order(a) < order(b) ? -1 : 1) || repoKey(a.repo).localeCompare(repoKey(b.repo)));

  const proposedKeys = new Set(proposals.keys());
  const untouchedSanityDocuments = input.existing
    .filter((d) => !(typeof d.repo === 'string' && proposedKeys.has(repoKey(d.repo))))
    .map((d) => `${d._id} (${String(d.repo)})`)
    .sort();

  // Effect on the website: current Sanity state vs. state after applying CREATE/UPDATE.
  const appliedDocs: ExistingProjectDoc[] = input.existing.map((d) => {
    const p = projects.find((x) => x.documentId === d._id && x.operation === 'UPDATE');
    return p ? { ...d, ...p.fields } : d;
  });
  for (const p of projects) if (p.operation === 'CREATE') appliedDocs.push({ _id: p.documentId!, ...p.fields });
  const before = render(input, input.existing);
  const after = render(input, appliedDocs);
  const intendedAdditions = new Set(additions.map((a) => repoKey(a.repo)));
  const differences: CompatibilityReport['differences'] = [];
  for (const [name, cur] of before.cards) {
    const next = after.cards.get(name);
    if (!next) continue;
    for (const field of Object.keys(cur) as (keyof CardSnapshot)[]) {
      if (!same(cur[field], next[field])) differences.push({ name, field, current: cur[field], proposed: next[field], intended: intendedAdditions.has(repoKey(name)) });
    }
  }
  // Shifts are intended only if removing the additions restores the current order exactly.
  const relativeOrderKept = same(after.featured.filter((n) => !intendedAdditions.has(repoKey(n))), before.featured);
  const positionChanges: CompatibilityReport['positionChanges'] = [];
  for (const name of new Set([...before.featured, ...after.featured])) {
    const cur = before.featured.indexOf(name);
    const next = after.featured.indexOf(name);
    if (cur !== next) {
      positionChanges.push({
        name, current: cur < 0 ? null : cur, proposed: next < 0 ? null : next,
        intended: intendedAdditions.has(repoKey(name)) || relativeOrderKept,
      });
    }
  }
  const compatibility: CompatibilityReport = {
    currentFeatured: before.featured,
    proposedFeatured: after.featured,
    differences,
    positionChanges,
    added: [...after.cards.keys()].filter((n) => !before.cards.has(n)),
    removed: [...before.cards.keys()].filter((n) => !after.cards.has(n)),
  };

  if (!input.schemaErrors) notes.push('Studio schema validation could not run (Studio dependencies missing) – only the website validation was applied.');
  notes.push(
    input.related
      ? 'Drafts, release versions and ID-occupying documents were checked (authenticated read).'
      : 'Only published Sanity documents are visible to this read-only check; unpublished drafts with the same IDs are not detected.',
  );
  for (const a of additions) {
    const at = proposals.get(repoKey(a.repo))!.fields.featuredOrder as number;
    notes.push(`${a.repo}: intentional addition (${a.source}), featured at position ${at + 1} (featuredOrder ${at}) as in the stash; the featured projects after it move down by one.`);
  }

  const operations: Record<Operation, number> = { CREATE: 0, UPDATE: 0, UNCHANGED: 0, SKIP: 0, BLOCKED: 0 };
  for (const p of projects) operations[p.operation]++;
  return {
    kind: PLAN_KIND,
    dryRun: true,
    executable: false,
    sources: { github: input.githubSource, sanity: input.sanitySource, schemaValidation: input.schemaValidation ?? (input.schemaErrors ? 'Studio schema' : 'unavailable') },
    summary: {
      githubRepositories: input.repos.length,
      configuredProjects: [...proposals.values()].filter((p) => p.origin === 'configuration').length,
      existingSanityDocuments: input.existing.length,
      operations,
      screenshotUploads: projects.filter((p) => p.screenshot.kind === 'upload-required').length,
    },
    projects,
    untouchedSanityDocuments,
    missingRepositories: missingRepositories.sort(),
    compatibility,
    notes,
    state: {
      repositories: input.repos.map((r) => r.name).sort(),
      documents: [...input.existing, ...(input.related ?? [])].map((d) => `${d._id}@${d._rev ?? '?'}`).sort(),
      draftsChecked: input.related !== undefined,
    },
  };
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;

/**
 * Deterministic fingerprint of a plan: target project/dataset, the GitHub repository names, every relevant Sanity
 * document with its revision, and the proposed operations with their exact values. Any change to these inputs –
 * a new edit in Sanity, a new draft, a new repository, a changed configuration – produces a different fingerprint.
 */
export function planFingerprint(plan: MigrationPlan, target: { projectId: string; dataset: string }): string {
  const operations = plan.projects.map((p) => ({ repo: p.repo, documentId: p.documentId, operation: p.operation, fields: p.fields, existingRev: p.existingRev ?? null }));
  const payload = canonical({ version: 1, target, state: plan.state, operations });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Sanity documents as the Studio would validate them (no screenshots, no system fields besides _id/_type). */
export const proposedDocuments = (plan: MigrationPlan) =>
  plan.projects.filter((p) => p.documentId).map((p) => ({ _id: p.documentId!, _type: 'project', ...p.fields }));

// ---------------------------------------------------------------------------------------------------- report ---

const v = (x: unknown) => (x === undefined || x === null ? '–' : Array.isArray(x) ? (x.length ? x.join(', ') : '[]') : String(x));
const cell = (x: unknown) => v(x).replace(/\|/g, '\\|');

export function renderReport(plan: MigrationPlan): string {
  const s = plan.summary;
  const out: string[] = [];
  out.push('# Sanity project migration – DRY RUN (read-only, not executable)', '');
  out.push(`- GitHub: ${plan.sources.github}`, `- Sanity: ${plan.sources.sanity}`, `- Schema validation: ${plan.sources.schemaValidation}`, '');
  out.push('## Summary', '');
  out.push('| | |', '| --- | --- |');
  out.push(`| GitHub repositories | ${s.githubRepositories} |`, `| Configured projects | ${s.configuredProjects} |`, `| Existing Sanity project documents | ${s.existingSanityDocuments} |`);
  for (const [op, n] of Object.entries(s.operations)) out.push(`| ${op} | ${n} |`);
  out.push(`| Screenshot uploads required | ${s.screenshotUploads} |`, '');

  out.push('## Projects', '');
  out.push('| Repository | Document ID | Operation | Title | Description | Category | Tags | Featured | Order | Accent | Hidden | Screenshot |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of plan.projects) {
    const f = p.fields;
    out.push(`| ${cell(p.repo)}${p.origin === 'addition' ? ' *(addition)*' : ''} | ${cell(p.documentId)} | **${p.operation}** | ${cell(f.title)} | ${cell(f.description)} | ${cell(f.category)} | ${cell(f.tags)} | ${cell(f.featured)} | ${cell(f.featuredOrder)} | ${cell(f.accent)} | ${cell(f.hidden)} | ${p.screenshot.kind} |`);
  }
  const withReasons = plan.projects.filter((p) => p.reasons.length);
  if (withReasons.length) {
    out.push('', '### Reasons', '');
    for (const p of withReasons) for (const r of p.reasons) out.push(`- **${p.repo}** (${p.operation}): ${r}`);
  }
  const conflicts = plan.projects.filter((p) => p.comparison.some((c) => c.status !== 'add'));
  if (conflicts.length) {
    out.push('', '### Field comparison with existing documents', '');
    for (const p of conflicts) {
      out.push(`**${p.repo}** (${p.documentId})`, '', '| Field | Existing | Proposed | Status |', '| --- | --- | --- | --- |');
      for (const c of p.comparison) out.push(`| ${c.field} | ${cell(c.existing)} | ${cell(c.proposed)} | ${c.status} |`);
      out.push('');
    }
  }

  out.push('', '## Screenshots', '');
  out.push('| Repository | Local path | File exists | Alt text | Position | Sanity asset | Upload required | Local fallback |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of plan.projects) {
    const st = p.screenshot;
    const l = 'local' in st ? st.local : null;
    out.push(`| ${cell(p.repo)} | ${cell(l?.path)} | ${l ? (l.exists ? 'yes' : '**no**') : '–'} | ${cell(l?.alt)} | ${cell(l?.position)} | ${cell(l?.sanityAssetId)} | ${st.kind === 'upload-required' ? '**yes (pending)**' : 'no'} | ${l?.exists ? 'yes' : '–'} |`);
  }

  const c = plan.compatibility;
  out.push('', '## Compatibility', '');
  out.push(`- Current featured order: ${c.currentFeatured.join(' → ') || '–'}`);
  out.push(`- Proposed featured order: ${c.proposedFeatured.join(' → ') || '–'}`);
  out.push(`- Cards added: ${c.added.join(', ') || 'none'} · removed: ${c.removed.join(', ') || 'none'}`);
  const unintended = c.differences.filter((d) => !d.intended);
  out.push(`- Differences on existing cards: ${c.differences.length} (${unintended.length} unintended)`, '');
  if (c.differences.length) {
    out.push('| Project | Field | Current | Proposed | Intended |', '| --- | --- | --- | --- | --- |');
    for (const d of c.differences) out.push(`| ${cell(d.name)} | ${d.field} | ${cell(d.current)} | ${cell(d.proposed)} | ${d.intended ? 'yes (addition)' : '**no**'} |`);
    out.push('');
  }
  if (c.positionChanges.length) {
    out.push('Featured position changes (1-based):', '', '| Project | Current | Proposed | Intended |', '| --- | --- | --- | --- |');
    const pos = (n: number | null) => (n === null ? '–' : String(n + 1));
    for (const d of c.positionChanges) out.push(`| ${cell(d.name)} | ${pos(d.current)} | ${pos(d.proposed)} | ${d.intended ? 'yes' : '**no**'} |`);
    out.push('');
  }
  out.push(`- Missing repositories: ${plan.missingRepositories.join(', ') || 'none'}`);
  out.push(`- Existing Sanity documents not covered by this plan: ${plan.untouchedSanityDocuments.join(', ') || 'none'}`);
  const blocked = plan.projects.filter((p) => p.operation === 'BLOCKED').map((p) => p.repo);
  out.push(`- Blocked / unresolved: ${blocked.join(', ') || 'none'}`);

  out.push('', '## Notes', '', ...plan.notes.map((n) => `- ${n}`));
  out.push('', '## Safety', '');
  out.push('- Read-only: GET requests only, no token sent, no Sanity client with write methods.');
  out.push('- No documents written, published or deleted; no assets uploaded; nothing deployed.');
  out.push('- The old stash and `docs/extend-projects` were only read.');
  return `${out.join('\n')}\n`;
}
