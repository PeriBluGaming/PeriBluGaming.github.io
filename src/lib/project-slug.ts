/**
 * URL slugs for project detail pages (/projects/<slug>/). Shared by the website and the Sanity Studio.
 * Pure, no imports, so `node --test`, Astro and the Studio can all load it.
 *
 * Slugs are derived from the GitHub repository name (not the display title), so renaming a project's title never
 * changes its URL. Once a page exists, its slug is stored (Sanity `slug` field or src/config/projects.ts →
 * detailPages) and never regenerated.
 */

export const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PROJECT_SLUG_MAX_LENGTH = 96;

/** "ToyStory2Recomp" → "toystory2recomp", "recomp-ui" → "recomp-ui", "snes_tools" → "snes-tools". */
export function slugifyProjectName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

export const isValidProjectSlug = (slug: unknown): slug is string =>
  typeof slug === 'string' && slug.length <= PROJECT_SLUG_MAX_LENGTH && PROJECT_SLUG_PATTERN.test(slug);

/** Site-relative URL of a project detail page (trailing slash: GitHub Pages serves /projects/<slug>/index.html). */
export const projectPagePath = (slug: string): string => `/projects/${slug}/`;
