/**
 * Which projects get a detail page (/projects/<slug>/) and under which slug – pure, unit-tested.
 *
 * A rendered (not hidden, not excluded) repository gets a page when ANY of these is true:
 * 1. it is featured right now (automatic, also for newly featured projects),
 * 2. the live site already publishes a page for it (live page manifest, /projects/pages.json) – this keeps pages
 *    online whatever happened to the featured flag, inside or outside the Studio,
 * 3. its Sanity document has `detailPageEnabled: true` (recorded by the Studio's Publish action),
 * 4. it is listed in the local `detailPages` configuration (permanent record for projects featured in code).
 * Projects that were never activated get no page. Repositories in `retiredDetailPages` never get one.
 *
 * Slugs: published slug (live manifest) → local configuration → Sanity `slug` → generated from the repository name.
 * Published and stored slugs are claimed first and retired slugs stay reserved, so a new project can never take an
 * existing URL: on a collision only the NEW project gets a numeric suffix (with a warning). The deploy guard
 * (src/lib/page-manifest.ts) refuses any build that would still change or drop a published page.
 */
import type { Accent, ProjectImage } from '../config/projects.ts';
import { emptyDetails, type ProjectDetails } from './project-details.ts';
import { repoKey, type EditorialOverride, type Project, type VisibleEntry } from './project-merge.ts';
import { isValidProjectSlug, projectPagePath, slugifyProjectName } from './project-slug.ts';

export interface ProjectPage {
  slug: string;
  path: string;
  project: Project;
  accent: Accent;
  /** Card image reused as hero; absent = stylised platform art. */
  image?: ProjectImage;
  details: ProjectDetails;
  /** Why the page exists (for diagnostics and tests). */
  reason: 'featured' | 'published' | 'sanity' | 'config';
}

export function selectProjectPages(input: {
  visible: VisibleEntry[];
  overrides: Map<string, EditorialOverride>;
  localPages: Record<string, string>;
  /** Pages of the live site (repository → slug), from its page manifest; empty if unknown. */
  publishedPages?: Record<string, string>;
  /** Pages explicitly and permanently removed (repository → slug); their slugs stay reserved. */
  retiredPages?: Record<string, string>;
}): { pages: ProjectPage[]; warnings: string[] } {
  const warnings: string[] = [];
  const local = new Map(Object.entries(input.localPages).map(([repo, slug]) => [repoKey(repo), slug]));
  const published = new Map(Object.entries(input.publishedPages ?? {}).map(([repo, slug]) => [repoKey(repo), slug]));
  const retired = new Map(Object.entries(input.retiredPages ?? {}).map(([repo, slug]) => [repoKey(repo), slug]));

  type Candidate = { entry: VisibleEntry; override?: EditorialOverride; reason: ProjectPage['reason']; stored: { slug: string; rank: number } | null };
  const candidates: Candidate[] = [];
  for (const entry of input.visible) {
    const k = repoKey(entry.project.name);
    const override = input.overrides.get(k);
    if (retired.has(k)) continue;
    const reason = entry.project.featured
      ? 'featured'
      : published.has(k)
        ? 'published'
        : override?.detailPageEnabled === true
          ? 'sanity'
          : local.has(k)
            ? 'config'
            : null;
    if (!reason) continue;

    let stored: Candidate['stored'] = null;
    const publishedSlug = published.get(k);
    if (publishedSlug !== undefined && isValidProjectSlug(publishedSlug)) stored = { slug: publishedSlug, rank: 0 };
    const localSlug = local.get(k);
    if (localSlug !== undefined) {
      if (!isValidProjectSlug(localSlug)) warnings.push(`Detail page: invalid slug "${localSlug}" for ${entry.project.name} in the local configuration – ignored`);
      else if (!stored) stored = { slug: localSlug, rank: 1 };
      else if (localSlug !== stored.slug) {
        warnings.push(`Detail page: configured slug "${localSlug}" for ${entry.project.name} differs from the published "${stored.slug}" – keeping the published URL`);
      }
    }
    if (override?.slug) {
      if (!stored) stored = { slug: override.slug, rank: 2 };
      else if (override.slug !== stored.slug) {
        const source = stored.rank === 0 ? 'published' : 'configured';
        warnings.push(`Detail page: Sanity slug "${override.slug}" for ${entry.project.name} differs from the ${source} "${stored.slug}" – using the ${source} one`);
      }
    }
    if (!stored && entry.project.featured) {
      warnings.push(
        `Detail page: featured project ${entry.project.name} has no stored slug yet – publish its Sanity document (records it) or add it to detailPages in src/config/projects.ts`,
      );
    }
    candidates.push({ entry, override, reason, stored });
  }

  // Claim order: published slugs, local slugs, Sanity slugs, generated slugs; each group by repository name.
  // Code-point comparison: deterministic regardless of the build machine's locale.
  const rank = (c: Candidate) => c.stored?.rank ?? 3;
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  candidates.sort((a, b) => rank(a) - rank(b) || byName(repoKey(a.entry.project.name), repoKey(b.entry.project.name)));

  // Retired slugs stay reserved: a removed page's URL is never handed to another project.
  const taken = new Set<string>([...retired.values()]);
  const pages: ProjectPage[] = [];
  for (const c of candidates) {
    const base = c.stored?.slug ?? slugifyProjectName(c.entry.project.name);
    if (!base) {
      warnings.push(`Detail page: cannot derive a slug for ${c.entry.project.name} – no page`);
      continue;
    }
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    if (slug !== base) warnings.push(`Detail page: slug "${base}" is already used – ${c.entry.project.name} gets "${slug}"`);
    taken.add(slug);
    pages.push({
      slug,
      path: projectPagePath(slug),
      project: c.entry.project,
      accent: c.entry.accent,
      ...(c.entry.image && { image: c.entry.image }),
      details: c.override?.details ?? emptyDetails(),
      reason: c.reason,
    });
  }
  pages.sort((a, b) => byName(a.slug, b.slug));
  return { pages, warnings };
}
