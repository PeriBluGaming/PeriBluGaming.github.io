/**
 * /projects/pages.json – the page manifest: every project detail page this build rendered (repository → slug) and
 * the latest release it shows. The next builds keep these pages and slugs, and the deploy workflow compares a new
 * build's manifest with the live one before deploying (src/lib/page-manifest.ts, docs/project-pages.md).
 * Contains public data only.
 */
import type { APIRoute } from 'astro';
import { toManifestRelease } from '../../lib/github-releases';
import { createManifest } from '../../lib/page-manifest';
import { getProjects, getReleaseResult } from '../../lib/projects';

export const GET: APIRoute = async () => {
  const { pages } = await getProjects();
  const entries = await Promise.all(
    pages.map(async (page) => {
      // Same cached result the page itself rendered.
      const { release, status } = await getReleaseResult(page.project.name);
      return { repo: page.project.name, slug: page.slug, release: release ? toManifestRelease(release) : null, releaseStatus: status };
    }),
  );
  return new Response(`${JSON.stringify(createManifest(entries), null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
