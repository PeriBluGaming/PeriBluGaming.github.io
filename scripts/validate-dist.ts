/**
 * Read-only consistency check of a finished build in dist/ – used by .github/workflows/pr-validation.yml.
 *
 *   npm run validate:dist
 *
 * Verifies the page manifest (/projects/pages.json) against the generated pages, the homepage links, the sitemap and
 * the build info. No network access, no writes. Exits non-zero with one line per problem.
 * Runs on plain Node (type stripping), no dependencies.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { detailPages } from '../src/config/projects.ts';
import { site } from '../src/config/site.ts';
import { parseBuildInfo } from '../src/lib/deploy-check.ts';
import { MANIFEST_SCHEMA, parseManifest, trustedReleaseUrl } from '../src/lib/page-manifest.ts';

const dist = new URL('../dist/', import.meta.url);
const problems: string[] = [];
const read = (path: string): string | null => {
  const file = new URL(path, dist);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};
const json = (path: string): unknown => {
  const text = read(path);
  if (text === null) return problems.push(`dist/${path} is missing`), undefined;
  try {
    return JSON.parse(text);
  } catch {
    return problems.push(`dist/${path} is not valid JSON`), undefined;
  }
};

// Build info declares the manifest.
const info = parseBuildInfo(json('build-info.json'));
if (!info) problems.push('dist/build-info.json is malformed');
else if (info.manifest !== MANIFEST_SCHEMA) problems.push(`dist/build-info.json declares manifest ${info.manifest} (expected ${MANIFEST_SCHEMA})`);

// Manifest is valid and complete.
const parsed = parseManifest(json('projects/pages.json'));
const pages = parsed.ok ? parsed.manifest.pages : [];
if (!parsed.ok) problems.push(`dist/projects/pages.json is invalid: ${parsed.reason}`);
const slugs = new Set(pages.map((p) => p.slug));
if (parsed.ok && pages.length === 0) problems.push('the page manifest lists no pages');
for (const [repo, slug] of Object.entries(detailPages)) {
  const entry = pages.find((p) => p.repo.toLowerCase() === repo.toLowerCase());
  if (!entry) problems.push(`configured detail page ${repo} (${slug}) is missing from the manifest`);
  else if (entry.slug !== slug) problems.push(`${repo}: manifest slug "${entry.slug}" differs from the configured "${slug}"`);
}

// Every manifest page exists, is canonical, and its release links are trusted; no unlisted pages.
for (const page of pages) {
  const html = read(`projects/${page.slug}/index.html`);
  if (html === null) {
    problems.push(`page /projects/${page.slug}/ (${page.repo}) is missing`);
    continue;
  }
  const canonical = new URL(`/projects/${page.slug}/`, site.url).href;
  if (!html.includes(`<link rel="canonical" href="${canonical}"`)) problems.push(`/projects/${page.slug}/ has no canonical link to ${canonical}`);
  if (!html.includes('id="project-title"')) problems.push(`/projects/${page.slug}/ has no project title`);
  for (const [, href] of html.matchAll(/href="(https:\/\/github\.com\/[^"]*\/releases\/[^"]*)"/g)) {
    if (!trustedReleaseUrl(href, page.repo)) problems.push(`/projects/${page.slug}/ links to an untrusted release URL ${href}`);
  }
  if (page.release && !html.includes(`href="${page.release.url}"`)) problems.push(`/projects/${page.slug}/ does not show its manifest release ${page.release.version}`);
}
const projectsDir = new URL('projects/', dist);
if (existsSync(projectsDir)) {
  for (const name of readdirSync(projectsDir)) {
    if (statSync(new URL(name, projectsDir)).isDirectory() && !slugs.has(name)) problems.push(`dist/projects/${name}/ is not listed in the manifest`);
  }
}

// Homepage links only to existing detail pages.
const home = read('index.html');
if (home === null) problems.push('dist/index.html is missing');
else {
  const links = [...home.matchAll(/href="\/projects\/([^"/]+)\/"/g)].map((m) => m[1]);
  if (links.length === 0) problems.push('the homepage links to no project detail page');
  for (const slug of links) if (!slugs.has(slug)) problems.push(`homepage links to /projects/${slug}/, which is not in the manifest`);
}

// Sitemap lists exactly the manifest's project pages.
const sitemap = read('sitemap.xml');
if (sitemap === null) problems.push('dist/sitemap.xml is missing');
else {
  const inSitemap = new Set([...sitemap.matchAll(/<loc>https:\/\/periblugaming\.github\.io\/projects\/([^<]+)\/<\/loc>/g)].map((m) => m[1]));
  for (const slug of slugs) if (!inSitemap.has(slug)) problems.push(`sitemap.xml is missing /projects/${slug}/`);
  for (const slug of inSitemap) if (!slugs.has(slug)) problems.push(`sitemap.xml lists /projects/${slug}/, which is not in the manifest`);
}
if (!read('robots.txt')?.includes(`Sitemap: ${new URL('/sitemap.xml', site.url).href}`)) problems.push('robots.txt does not reference the sitemap');

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::dist: ${p}`);
  process.exit(1);
}
console.log(`dist OK: ${pages.length} project page(s) (${pages.map((p) => p.slug).join(', ')}), manifest, homepage links, sitemap and build info consistent.`);
