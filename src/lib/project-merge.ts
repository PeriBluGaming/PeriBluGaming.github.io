/**
 * Merges GitHub repositories with editorial overrides – pure, no network or file system (unit-tested).
 *
 * Ownership:
 * - GitHub owns identity and technical data: name, URL, stars, language, push date, fork/archived. Never overridden.
 * - Editorial fields resolve per field: explicit Sanity value → local configuration (src/config/projects.ts) →
 *   GitHub / built-in default. "Explicit" means present in the normalised Sanity override – `false`, `[]` and an
 *   empty description are explicit values; unset fields fall through.
 * - Sanity documents only ever modify repositories GitHub returned; they never create cards.
 */
import type { Accent, Category, CategoryId, FeaturedEntry, ProjectImage, ProjectOverride } from '../config/projects.ts';
import type { RepoData } from './github.ts';

export interface Project {
  name: string;
  title: string;
  description: string | null;
  url: string;
  category: Category;
  tags: string[];
  language: string | null;
  stars: number;
  pushedAt: string;
  fork: boolean;
  archived: boolean;
  featured: boolean;
}

export interface FeaturedProject extends Project {
  accent: Accent;
  /** Validated screenshot; absent = stylised platform art. */
  image?: ProjectImage;
}

/** A validated Sanity `project` document. Unset fields are absent (no override). */
export interface EditorialOverride {
  /** Repository name as written in Sanity (trimmed). */
  repo: string;
  sourceId: string;
  updatedAt: string;
  title?: string;
  /** `null` = explicitly no description. */
  description?: string | null;
  category?: CategoryId;
  tags?: string[];
  hidden?: boolean;
  featured?: boolean;
  featuredOrder?: number;
  accent?: Accent;
  image?: ProjectImage;
}

export interface MergeConfig {
  categories: Category[];
  defaultCategory: CategoryId;
  projectOverrides: Record<string, ProjectOverride>;
  featuredProjects: FeaturedEntry[];
  listSettings: { hideForks: boolean; hideArchived: boolean; exclude: string[] };
}

export interface MergeResult {
  featured: FeaturedProject[];
  all: Project[];
  categories: Category[];
  warnings: string[];
}

const ACCENTS: readonly Accent[] = ['cyan', 'pink', 'violet'];
const MAX_TAGS = 2;

/** Matching key: GitHub treats repository names case-insensitively. */
export const repoKey = (name: string): string => name.trim().toLowerCase();

const has = <K extends keyof EditorialOverride>(o: EditorialOverride | undefined, k: K): o is EditorialOverride & Required<Pick<EditorialOverride, K>> =>
  o !== undefined && Object.prototype.hasOwnProperty.call(o, k);

/**
 * Validates one raw Sanity document. Invalid fields are dropped (with a warning) so they fall back individually;
 * a document without a usable `repo` is skipped. `resolveImage` turns the first screenshot into a ProjectImage.
 */
export function normalizeSanityProject(
  raw: unknown,
  { categoryIds, resolveImage }: { categoryIds: ReadonlySet<string>; resolveImage: (shot: unknown) => ProjectImage | null },
): { override: EditorialOverride | null; warnings: string[] } {
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { override: null, warnings: ['Sanity project: not an object – skipped'] };
  const d = raw as Record<string, unknown>;
  const id = typeof d._id === 'string' ? d._id : '(no id)';
  const label = `Sanity project ${id}`;

  if (typeof d.repo !== 'string' || d.repo.trim() === '') {
    return { override: null, warnings: [`${label}: missing repository name – skipped`] };
  }
  const o: EditorialOverride = {
    repo: d.repo.trim(),
    sourceId: id,
    updatedAt: typeof d._updatedAt === 'string' ? d._updatedAt : '',
  };
  const invalid = (field: string) => warnings.push(`${label} (${o.repo}): invalid ${field} – using fallback`);
  const present = (field: string) => d[field] !== undefined && d[field] !== null;

  if (present('title')) {
    if (typeof d.title === 'string' && d.title.trim() !== '') o.title = d.title.trim();
    else invalid('title');
  }
  if (present('description')) {
    if (typeof d.description === 'string') o.description = d.description.trim() || null;
    else invalid('description');
  }
  if (present('category')) {
    if (typeof d.category === 'string' && categoryIds.has(d.category)) o.category = d.category as CategoryId;
    else invalid('category');
  }
  if (present('tags')) {
    const tags = Array.isArray(d.tags) ? d.tags : null;
    if (tags && tags.every((t) => typeof t === 'string')) {
      const clean = (tags as string[]).map((t) => t.trim()).filter((t) => t !== '');
      if (clean.length !== tags.length || clean.length > MAX_TAGS) warnings.push(`${label} (${o.repo}): tags cleaned up (empty values removed, max ${MAX_TAGS})`);
      o.tags = clean.slice(0, MAX_TAGS);
    } else invalid('tags');
  }
  for (const field of ['hidden', 'featured'] as const) {
    if (present(field)) {
      if (typeof d[field] === 'boolean') o[field] = d[field] as boolean;
      else invalid(field);
    }
  }
  if (present('featuredOrder')) {
    if (typeof d.featuredOrder === 'number' && Number.isInteger(d.featuredOrder) && d.featuredOrder >= 0) o.featuredOrder = d.featuredOrder;
    else invalid('featuredOrder');
  }
  if (present('accent')) {
    if (typeof d.accent === 'string' && (ACCENTS as readonly string[]).includes(d.accent)) o.accent = d.accent as Accent;
    else invalid('accent');
  }
  if (present('screenshot')) {
    const image = resolveImage(d.screenshot);
    if (image) o.image = image;
    else invalid('screenshot');
  }
  return { override: o, warnings };
}

/**
 * One override per repository. Duplicates (same repo, case-insensitive) resolve deterministically, independent of
 * the API order: the most recently updated document wins, ties by document ID.
 */
export function selectOverrides(overrides: EditorialOverride[]): { byKey: Map<string, EditorialOverride>; warnings: string[] } {
  const groups = new Map<string, EditorialOverride[]>();
  for (const o of overrides) groups.set(repoKey(o.repo), [...(groups.get(repoKey(o.repo)) ?? []), o]);

  const byKey = new Map<string, EditorialOverride>();
  const warnings: string[] = [];
  for (const [k, docs] of groups) {
    const sorted = [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sourceId.localeCompare(b.sourceId));
    byKey.set(k, sorted[0]);
    if (sorted.length > 1) {
      warnings.push(
        `Sanity: ${sorted.length} project documents for "${sorted[0].repo}" – using ${sorted[0].sourceId} (most recently updated), ignoring ${sorted
          .slice(1)
          .map((d) => d.sourceId)
          .join(', ')}`,
      );
    }
  }
  return { byKey, warnings };
}

const compareNumbers = (a: number | undefined, b: number | undefined) =>
  a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a - b;

export function mergeProjects(input: {
  repos: RepoData[];
  overrides: Map<string, EditorialOverride>;
  config: MergeConfig;
  /** Validates a local screenshot from the featured configuration (throws on misconfiguration). */
  resolveLocalImage: (image: ProjectImage, repo: string) => ProjectImage;
}): MergeResult {
  const { repos, overrides, config, resolveLocalImage } = input;
  const warnings: string[] = [];
  const categoryById = new Map(config.categories.map((c) => [c.id, c]));
  const local = new Map(Object.entries(config.projectOverrides).map(([name, o]) => [repoKey(name), o]));
  const localFeatured = new Map(config.featuredProjects.map((f, index) => [repoKey(f.repo), { ...f, index }]));
  const excluded = new Set(config.listSettings.exclude.map(repoKey));
  const repoKeys = new Set(repos.map((r) => repoKey(r.name)));

  for (const [k, o] of overrides) {
    if (!repoKeys.has(k)) warnings.push(`Sanity project "${o.repo}" (${o.sourceId}) has no matching public repository – ignored`);
  }

  type Entry = { project: Project; accent: Accent; image?: ProjectImage; order?: number; localIndex?: number };
  const entries: Entry[] = [];

  for (const repo of repos) {
    const k = repoKey(repo.name);
    if (excluded.has(k)) continue; // configuration-level exclusion (e.g. this website's own repository)
    const s = overrides.get(k);
    const l = local.get(k) ?? {};
    const f = localFeatured.get(k);

    if (has(s, 'hidden') ? s.hidden : (l.hidden ?? false)) continue;

    const categoryId = has(s, 'category') ? s.category : (l.category ?? config.defaultCategory);
    const category = categoryById.get(categoryId) ?? categoryById.get(config.defaultCategory)!;
    const featured = has(s, 'featured') ? s.featured : f !== undefined;

    const project: Project = {
      name: repo.name,
      title: has(s, 'title') ? s.title : (l.title ?? repo.name),
      description: has(s, 'description') ? s.description : (l.description ?? repo.description),
      url: repo.url,
      category,
      tags: (has(s, 'tags') ? s.tags : (l.tags ?? [])).slice(0, MAX_TAGS),
      language: repo.language,
      stars: repo.stars,
      pushedAt: repo.pushedAt,
      fork: repo.fork,
      archived: repo.archived,
      featured,
    };

    let image: ProjectImage | undefined;
    if (featured) {
      // Local screenshots are validated whenever the card is rendered, so a broken config still fails the build.
      const localImage = f?.image ? resolveLocalImage(f.image, repo.name) : undefined;
      image = has(s, 'image') ? s.image : localImage;
    }
    entries.push({
      project,
      accent: has(s, 'accent') ? s.accent : (f?.accent ?? category.accent),
      image,
      order: has(s, 'featuredOrder') ? s.featuredOrder : f?.index,
      localIndex: f?.index,
    });
  }

  for (const [k, f] of localFeatured) {
    if (!repoKeys.has(k)) warnings.push(`Featured repository "${f.repo}" is not publicly available – skipped.`);
  }

  // Featured order: explicit order (Sanity featuredOrder, else position in the local list) → local position → name.
  const featuredEntries = entries
    .filter((e) => e.project.featured)
    .sort(
      (a, b) =>
        compareNumbers(a.order, b.order) ||
        compareNumbers(a.localIndex, b.localIndex) ||
        repoKey(a.project.name).localeCompare(repoKey(b.project.name)),
    );
  const rank = new Map(featuredEntries.map((e, i) => [e.project.name, i]));

  // Featured projects bypass the fork/archive filters so they never go missing.
  const { hideForks, hideArchived } = config.listSettings;
  const all = entries
    .map((e) => e.project)
    .filter((p) => p.featured || ((!hideForks || !p.fork) && (!hideArchived || !p.archived)))
    .sort(
      (a, b) =>
        compareNumbers(rank.get(a.name), rank.get(b.name)) ||
        b.pushedAt.localeCompare(a.pushedAt) ||
        repoKey(a.name).localeCompare(repoKey(b.name)),
    );

  const featured = featuredEntries.map(({ project, accent, image }) => ({ ...project, accent, ...(image && { image }) }));
  const used = new Set(all.map((p) => p.category.id));
  return { featured, all, categories: config.categories.filter((c) => used.has(c.id)), warnings };
}
