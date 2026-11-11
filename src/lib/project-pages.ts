/**
 * Which projects get a detail page (/projects/<slug>/) and under which slug – pure, unit-tested.
 *
 * A rendered (not hidden, not excluded) repository gets a page when ANY of these is true:
 * 1. it is featured right now (automatic, also for newly featured projects),
 * 2. its Sanity document has `detailPageEnabled: true` (recorded by the Studio's Publish action the first time the
 *    project was published as featured – stays when it stops being featured),
 * 3. it is listed in the local `detailPages` configuration (permanent record for projects featured in code).
 * Projects that were never activated get no page.
 *
 * Slugs: local configuration → Sanity `slug` → generated from the repository name. Stored slugs are claimed first,
 * so a generated slug can never take a stored one. A collision never fails the build: the later project gets a
 * numeric suffix and a warning.
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
  reason: 'featured' | 'sanity' | 'config';
}

export function selectProjectPages(input: {
  visible: VisibleEntry[];
  overrides: Map<string, EditorialOverride>;
  localPages: Record<string, string>;
}): { pages: ProjectPage[]; warnings: string[] } {
  const warnings: string[] = [];
  const local = new Map(Object.entries(input.localPages).map(([repo, slug]) => [repoKey(repo), slug]));

  type Candidate = { entry: VisibleEntry; override?: EditorialOverride; reason: ProjectPage['reason']; stored: { slug: string; rank: number } | null };
  const candidates: Candidate[] = [];
  for (const entry of input.visible) {
    const k = repoKey(entry.project.name);
    const override = input.overrides.get(k);
    const reason = entry.project.featured ? 'featured' : override?.detailPageEnabled === true ? 'sanity' : local.has(k) ? 'config' : null;
    if (!reason) continue;

    let stored: Candidate['stored'] = null;
    const localSlug = local.get(k);
    if (localSlug !== undefined) {
      if (isValidProjectSlug(localSlug)) stored = { slug: localSlug, rank: 0 };
      else warnings.push(`Detail page: invalid slug "${localSlug}" for ${entry.project.name} in the local configuration – ignored`);
    }
    if (override?.slug) {
      if (!stored) stored = { slug: override.slug, rank: 1 };
      else if (override.slug !== stored.slug) {
        warnings.push(`Detail page: Sanity slug "${override.slug}" for ${entry.project.name} differs from the configured "${stored.slug}" – using the configured one`);
      }
    }
    if (!stored && entry.project.featured) {
      warnings.push(
        `Detail page: featured project ${entry.project.name} has no stored slug yet – publish its Sanity document (records it) or add it to detailPages in src/config/projects.ts`,
      );
    }
    candidates.push({ entry, override, reason, stored });
  }

  // Claim order: stored local slugs, stored Sanity slugs, generated slugs; each group by repository name.
  // Code-point comparison: deterministic regardless of the build machine's locale.
  const rank = (c: Candidate) => c.stored?.rank ?? 2;
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  candidates.sort((a, b) => rank(a) - rank(b) || byName(repoKey(a.entry.project.name), repoKey(b.entry.project.name)));

  const taken = new Set<string>();
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
