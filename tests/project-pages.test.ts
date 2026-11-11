/**
 * Project detail pages: slugs, page selection and persistence (src/lib/project-pages.ts, Studio publish rules),
 * detail content normalisation, YouTube handling and the latest-release integration. No network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { categories, defaultCategory, detailPages, featureIcons, featuredProjects, listSettings, projectOverrides } from '../src/config/projects.ts';
import type { BlogConfig } from '../src/lib/blog/config.ts';
import type { ImageResolver } from '../src/lib/blog/normalize.ts';
import { createReleaseLoader, fetchLatestRelease, normalizeRelease } from '../src/lib/github-releases.ts';
import { GitHubApiError, type RepoData } from '../src/lib/github.ts';
import { buildProjectData, type ProjectSources } from '../src/lib/project-data.ts';
import { normalizeProjectDetails } from '../src/lib/project-details.ts';
import { validateProjectImage } from '../src/lib/project-image.ts';
import { normalizeSanityProject, type EditorialOverride, type VisibleEntry } from '../src/lib/project-merge.ts';
import { selectProjectPages } from '../src/lib/project-pages.ts';
import { isValidProjectSlug, projectPagePath, slugifyProjectName } from '../src/lib/project-slug.ts';
import { parseYouTubeId, youTubeEmbedUrl } from '../src/lib/youtube.ts';
import { detailPagePatch, validateProjectSlug, validateUniqueSlug, validateYouTubeUrl } from '../studio/schemaTypes/projectRules.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fallback = JSON.parse(readFileSync(join(root, 'src/data/fallback-repos.json'), 'utf8')) as { fetchedAt: string; repos: RepoData[] };
const sanity: BlogConfig = { mode: 'sanity', projectId: 'abc123xy', dataset: 'production', apiVersion: '2025-02-19', allowFailure: false };

/** Fake Sanity image resolver: accepts `image-…` asset IDs, returns deterministic CDN URLs. */
const resolver: ImageResolver = (raw, widths) => {
  const id = raw.asset?._id;
  if (typeof id !== 'string' || !id.startsWith('image-')) return null;
  const url = (w: number) => `https://cdn.sanity.io/images/abc123xy/production/${id}.webp?w=${w}`;
  return { src: url(widths[Math.min(1, widths.length - 1)]), srcset: widths.map((w) => `${url(w)} ${w}w`).join(', '), width: 1920, height: 1080 };
};
const asset = (n = 1) => ({ _id: `image-a${n}-1920x1080-png`, metadata: { dimensions: { width: 1920, height: 1080 } } });

function sources(overrides: Partial<ProjectSources> = {}): { s: ProjectSources; warnings: string[] } {
  const warnings: string[] = [];
  const s: ProjectSources = {
    env: {},
    config: { categories, defaultCategory, projectOverrides, featuredProjects, listSettings },
    githubUser: 'PeriBluGaming',
    fallback,
    fetchRepos: async () => fallback.repos,
    sanityConfig: sanity,
    fetchSanityProjects: async () => [],
    screenshotResolver: () => (shot) =>
      shot && typeof shot === 'object' && (shot as { alt?: string }).alt
        ? { src: 'https://cdn.sanity.io/images/abc123xy/production/x.webp?w=800', alt: (shot as { alt: string }).alt, position: '50% 20%' }
        : null,
    resolveLocalImage: (image, repo) => validateProjectImage(image, repo, join(root, 'public')),
    detailPages,
    detailImageResolver: () => resolver,
    log: { warn: (m: string) => warnings.push(m) },
    ...overrides,
  };
  return { s, warnings };
}

const doc = (repo: string, fields: Record<string, unknown> = {}) => ({ _id: `p-${repo}`, _rev: 'r1', _updatedAt: '2026-11-01T00:00:00Z', repo, ...fields });

// ── Slugs ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('project slugs', () => {
  it('derives lowercase URL slugs from repository names', () => {
    assert.equal(slugifyProjectName('ToyStory2Recomp'), 'toystory2recomp');
    assert.equal(slugifyProjectName('recomp-ui'), 'recomp-ui');
    assert.equal(slugifyProjectName('snes_tools.v2'), 'snes-tools-v2');
    assert.equal(slugifyProjectName('  Café  Tools '), 'cafe-tools');
    assert.equal(slugifyProjectName('---'), '');
    assert.equal(slugifyProjectName('a'.repeat(200)).length, 96);
  });

  it('validates slugs and builds trailing-slash paths', () => {
    for (const ok of ['toystory2recomp', 'recomp-ui', 'a1']) assert.equal(isValidProjectSlug(ok), true, ok);
    for (const bad of ['Toy', 'a--b', '-a', 'a-', 'a b', '', 'a/b', 'a'.repeat(97), 42]) assert.equal(isValidProjectSlug(bad), false, String(bad));
    assert.equal(projectPagePath('toystory2recomp'), '/projects/toystory2recomp/');
  });

  it('local configuration: every featured project is recorded permanently, slugs are valid and unique', () => {
    const keys = new Set(Object.keys(detailPages).map((r) => r.toLowerCase()));
    for (const f of featuredProjects) assert.ok(keys.has(f.repo.toLowerCase()), `${f.repo} is featured but missing from detailPages`);
    const slugs = Object.values(detailPages);
    for (const slug of slugs) assert.equal(isValidProjectSlug(slug), true, slug);
    assert.equal(new Set(slugs).size, slugs.length);
    assert.equal(detailPages.ToyStory2Recomp, 'toystory2recomp'); // the documented URL
  });
});

// ── Page selection ─────────────────────────────────────────────────────────────────────────────────────────────

const entry = (name: string, featured = false, title = name): VisibleEntry => ({
  project: {
    name,
    title,
    description: null,
    url: `https://github.com/PeriBluGaming/${name}`,
    category: categories[0],
    tags: [],
    language: null,
    stars: 0,
    pushedAt: '2026-01-01T00:00:00Z',
    fork: false,
    archived: false,
    featured,
  },
  accent: 'cyan',
});
const ov = (repo: string, extra: Partial<EditorialOverride> = {}): [string, EditorialOverride] => [repo.toLowerCase(), { repo, sourceId: `p-${repo}`, updatedAt: '', ...extra }];
const select = (visible: VisibleEntry[], overrides: [string, EditorialOverride][] = [], localPages: Record<string, string> = {}) =>
  selectProjectPages({ visible, overrides: new Map(overrides), localPages });
const slugs = (r: ReturnType<typeof select>) => Object.fromEntries(r.pages.map((p) => [p.project.name, p.slug]));

describe('selectProjectPages', () => {
  it('gives every featured project a page, and newly featured ones automatically', () => {
    const r = select([entry('Alpha', true), entry('Beta', true), entry('Gamma')]);
    assert.deepEqual(slugs(r), { Alpha: 'alpha', Beta: 'beta' });
    assert.ok(r.pages.every((p) => p.reason === 'featured' && p.path === `/projects/${p.slug}/`));
  });

  it('keeps pages of previously activated projects (Sanity record or local record) that are no longer featured', () => {
    const r = select([entry('Alpha'), entry('Beta'), entry('Gamma')], [ov('Alpha', { detailPageEnabled: true, slug: 'alpha' })], { Beta: 'beta' });
    assert.deepEqual(slugs(r), { Alpha: 'alpha', Beta: 'beta' });
    assert.deepEqual(r.pages.map((p) => p.reason), ['sanity', 'config']);
  });

  it('never creates pages for projects that were never activated', () => {
    const r = select([entry('Alpha'), entry('Beta')], [ov('Alpha', { detailPageEnabled: false, slug: 'alpha' }), ov('Beta', { title: 'x' })]);
    assert.deepEqual(r.pages, []);
  });

  it('hidden / excluded projects get no page (they are not in the visible list)', () => {
    assert.deepEqual(select([], [ov('Alpha', { detailPageEnabled: true })], { Beta: 'beta' }).pages, []);
  });

  it('keeps stored slugs when the title changes', () => {
    const before = select([entry('ToyStory2Recomp', true, 'Toy Story 2 Recomp')], [], detailPages);
    const after = select([entry('ToyStory2Recomp', true, 'Toy Story 2: Recompiled')], [], detailPages);
    assert.equal(before.pages[0].slug, 'toystory2recomp');
    assert.equal(after.pages[0].slug, 'toystory2recomp');
    // Generated slugs come from the repository name, never the title.
    assert.equal(select([entry('NewRecomp', true, 'Something Else')]).pages[0].slug, 'newrecomp');
  });

  it('keeps a stored slug even if the repository is renamed', () => {
    const r = select([entry('RenamedRepo')], [ov('RenamedRepo', { detailPageEnabled: true, slug: 'old-name' })]);
    assert.equal(r.pages[0].slug, 'old-name');
  });

  it('resolves slug collisions safely: stored slugs win, later ones get a suffix and a warning', () => {
    const r = select(
      [entry('Foo-Bar', true), entry('foo_bar', true), entry('Other', true)],
      [ov('Other', { slug: 'foo-bar' })],
    );
    assert.deepEqual(slugs(r), { Other: 'foo-bar', 'Foo-Bar': 'foo-bar-2', foo_bar: 'foo-bar-3' });
    assert.equal(new Set(r.pages.map((p) => p.slug)).size, 3);
    assert.match(r.warnings.join('\n'), /"foo-bar" is already used – Foo-Bar gets "foo-bar-2"/);
  });

  it('prefers the local record over a different Sanity slug, with a warning', () => {
    const r = select([entry('Alpha', true)], [ov('Alpha', { slug: 'alpha-new' })], { Alpha: 'alpha' });
    assert.equal(r.pages[0].slug, 'alpha');
    assert.match(r.warnings.join('\n'), /differs from the configured "alpha"/);
  });

  it('warns when a featured project has no stored slug yet, ignores invalid local slugs', () => {
    assert.match(select([entry('Alpha', true)]).warnings.join('\n'), /no stored slug yet/);
    const r = select([entry('Alpha', true)], [], { Alpha: 'Not Valid' });
    assert.equal(r.pages[0].slug, 'alpha');
    assert.match(r.warnings.join('\n'), /invalid slug "Not Valid"/);
  });
});

// ── Studio publish rules (persistent activation) ───────────────────────────────────────────────────────────────

describe('detailPagePatch (Studio publish action)', () => {
  it('activates and stores a slug when a featured project is published', () => {
    assert.deepEqual(detailPagePatch({ repo: 'NewRecomp', featured: true }, null), {
      detailPageEnabled: true,
      slug: { _type: 'slug', current: 'newrecomp' },
    });
  });

  it('activates when the published version was featured (un-featuring keeps the page)', () => {
    assert.deepEqual(detailPagePatch({ repo: 'Alpha', featured: false }, { repo: 'Alpha', featured: true }), {
      detailPageEnabled: true,
      slug: { _type: 'slug', current: 'alpha' },
    });
  });

  it('activates projects featured through the local configuration unless Sanity explicitly un-features them', () => {
    assert.ok(detailPagePatch({ repo: 'toystory2recomp' }, null, ['ToyStory2Recomp'])?.detailPageEnabled);
    assert.equal(detailPagePatch({ repo: 'ToyStory2Recomp', featured: false }, null, ['ToyStory2Recomp']), null);
  });

  it('uses the locally recorded slug for locally recorded projects', () => {
    assert.deepEqual(detailPagePatch({ repo: 'ToyStory2Recomp', featured: true }, null, [], { ToyStory2Recomp: 'toystory2recomp' })?.slug, {
      _type: 'slug',
      current: 'toystory2recomp',
    });
  });

  it('never touches an existing slug and does nothing for never-featured projects', () => {
    assert.equal(detailPagePatch({ repo: 'Alpha', featured: true, detailPageEnabled: true, slug: { current: 'custom' } }, null), null);
    assert.deepEqual(detailPagePatch({ repo: 'Alpha', featured: true, slug: { current: 'custom' } }, null), { detailPageEnabled: true });
    assert.equal(detailPagePatch({ repo: 'Alpha' }, { repo: 'Alpha' }), null);
    assert.equal(detailPagePatch({ repo: 'Alpha', featured: false }, null), null);
    assert.equal(detailPagePatch(null, null), null);
  });

  it('fills in a missing slug for an already active page', () => {
    assert.deepEqual(detailPagePatch({ repo: 'Alpha', detailPageEnabled: true }, null), { slug: { _type: 'slug', current: 'alpha' } });
  });
});

describe('Studio validation rules for detail pages', () => {
  const lookup = (docs: unknown) => ({ fetch: async () => docs });
  it('validates slug format', () => {
    assert.equal(validateProjectSlug(undefined), true);
    assert.equal(validateProjectSlug({ current: 'ok-slug' }), true);
    assert.equal(typeof validateProjectSlug({ current: 'Not OK' }), 'string');
  });

  it('checks slug uniqueness against other documents and the local configuration, failing closed', async () => {
    assert.equal(await validateUniqueSlug({ current: 'x' }, 'drafts.p1', 'A', lookup([{ _id: 'p1', slug: 'x' }])), true);
    assert.match(String(await validateUniqueSlug({ current: 'x' }, 'drafts.p1', 'A', lookup([{ _id: 'p2', slug: 'x' }]))), /already used/);
    assert.match(String(await validateUniqueSlug({ current: 'toystory2recomp' }, 'p1', 'Other', lookup([]), detailPages)), /ToyStory2Recomp/);
    assert.equal(await validateUniqueSlug({ current: 'toystory2recomp' }, 'p1', 'toystory2recomp', lookup([]), detailPages), true);
    assert.match(String(await validateUniqueSlug({ current: 'alpha' }, 'p1', 'ToyStory2Recomp', lookup([]), detailPages)), /fixed by the website configuration/);
    assert.match(String(await validateUniqueSlug({ current: 'x' }, 'p1', 'A', { fetch: async () => Promise.reject(new Error('offline')) })), /Could not check/);
  });

  it('accepts YouTube links only', () => {
    assert.equal(validateYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
    assert.equal(typeof validateYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), 'string');
  });
});

// ── YouTube ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('parseYouTubeId', () => {
  it('extracts the ID from the common URL formats', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      ' http://www.youtube.com/watch?v=dQw4w9WgXcQ ',
    ]) {
      assert.equal(parseYouTubeId(url), 'dQw4w9WgXcQ', url);
    }
  });

  it('rejects other hosts, schemes, malformed IDs and injection attempts', () => {
    for (const url of [
      'https://evil.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)//youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/short',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ"onload=',
      'https://www.youtube.com/playlist?list=PL123',
      'https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ',
      'not a url',
      '',
      null,
    ]) {
      assert.equal(parseYouTubeId(url), null, String(url));
    }
  });

  it('builds a privacy-enhanced embed URL from the ID only', () => {
    assert.equal(youTubeEmbedUrl('dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0');
  });
});

// ── Detail content ─────────────────────────────────────────────────────────────────────────────────────────────

describe('normalizeProjectDetails', () => {
  it('returns empty sections for documents without detail fields', () => {
    const { details, warnings } = normalizeProjectDetails({ repo: 'X' }, resolver, 'p');
    assert.deepEqual(details, { longDescription: [], features: [], gallery: [], videos: [] });
    assert.deepEqual(warnings, []);
  });

  it('normalises rich text, features, gallery and videos in editor order', () => {
    const { details, warnings } = normalizeProjectDetails(
      {
        screenshot: { alt: 'Hero', asset: asset(1) },
        longDescription: [
          { _type: 'block', _key: 'b1', style: 'h2', markDefs: [], children: [{ _type: 'span', _key: 's', text: 'About', marks: [] }] },
          {
            _type: 'block',
            _key: 'b2',
            markDefs: [{ _key: 'l1', _type: 'link', href: 'javascript:alert(1)' }, { _key: 'l2', _type: 'link', href: 'https://example.com' }],
            children: [{ _type: 'span', _key: 's', text: 'Text', marks: ['l1', 'l2'] }],
          },
        ],
        features: [
          { _key: 'f2', title: 'Second', description: 'D', icon: 'cpu' },
          { _key: 'f1', title: 'First', image: { alt: 'Shot', asset: asset(2) }, icon: 'not-an-icon' },
          { _key: 'f3', title: '  ' },
          { _key: 'f4', title: 'Broken image', image: { asset: asset(3) } },
        ],
        screenshots: [
          { _key: 'g1', alt: 'One', caption: ' Caption ', asset: asset(4) },
          { _key: 'g2', alt: '', asset: asset(5) },
          { _key: 'g3', alt: 'No asset' },
        ],
        videos: [
          { _key: 'v1', url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Trailer' },
          { _key: 'v2', url: 'https://vimeo.com/1' },
          { _key: 'v3', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
          { _key: 'v4', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
        ],
      },
      resolver,
      'p',
    );
    assert.equal(details.hero?.alt, 'Hero');
    assert.match(details.hero!.srcset!, /1920w/);
    assert.deepEqual(details.longDescription.map((b) => b._type === 'block' && b.style), ['h2', 'normal']);
    const links = details.longDescription[1]._type === 'block' ? details.longDescription[1].markDefs.map((d) => d.href) : [];
    assert.deepEqual(links, [null, 'https://example.com/']); // unsafe link reduced to plain text
    assert.deepEqual(details.features.map((f) => [f.title, f.icon, f.image?.alt]), [
      ['Second', 'cpu', undefined],
      ['First', undefined, 'Shot'],
      ['Broken image', undefined, undefined],
    ]);
    assert.deepEqual(details.gallery.map((g) => [g.key, g.thumb.alt, g.caption]), [['g1', 'One', 'Caption']]);
    assert.match(details.gallery[0].full, /w=1920/);
    assert.deepEqual(details.videos.map((v) => [v.id, v.title]), [['dQw4w9WgXcQ', 'Trailer'], ['abcdefghijk', undefined]]);
    assert.equal(warnings.length, 6);
  });

  it('only offers icons that exist in Icon.astro', () => {
    const icons = readFileSync(join(root, 'src/components/Icon.astro'), 'utf8');
    for (const { value } of featureIcons) assert.match(icons, new RegExp(`\\n  '?${value}'?: \\{`), value);
  });
});

describe('normalizeSanityProject: detail page fields', () => {
  const opts = { categoryIds: new Set(categories.map((c) => c.id)), resolveImage: () => null, resolveDetailImage: resolver };
  it('reads slug and activation flag, drops invalid values with a warning', () => {
    const ok = normalizeSanityProject(doc('A', { slug: { current: 'a-page' }, detailPageEnabled: true }), opts);
    assert.equal(ok.override?.slug, 'a-page');
    assert.equal(ok.override?.detailPageEnabled, true);
    const bad = normalizeSanityProject(doc('A', { slug: { current: 'A Page' }, detailPageEnabled: 'yes' }), opts);
    assert.equal(bad.override?.slug, undefined);
    assert.equal(bad.override?.detailPageEnabled, undefined);
    assert.equal(bad.warnings.length, 2);
  });

  it('existing documents without detail fields stay valid and warning-free', () => {
    const r = normalizeSanityProject(doc('A', { title: 'T', featured: true }), opts);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.override?.details, { longDescription: [], features: [], gallery: [], videos: [] });
  });
});

// ── Pipeline ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('buildProjectData: detail pages', () => {
  it('creates a page for every current featured project and links the featured cards to it', async () => {
    const { s, warnings } = sources();
    const data = await buildProjectData(s);
    assert.deepEqual(data.pages.map((p) => p.slug).sort(), Object.values(detailPages).sort());
    for (const p of data.featured) assert.equal(p.detailPath, `/projects/${detailPages[p.name]}/`, p.name);
    // Hero reuses the existing card image.
    for (const page of data.pages) assert.equal(page.image?.src, featuredProjects.find((f) => f.repo === page.project.name)?.image?.src);
    assert.deepEqual(warnings, []);
  });

  it('keeps a page after a project stops being featured, and adds pages for newly featured ones', async () => {
    const { s } = sources({
      fetchSanityProjects: async () => [
        doc('ToyStory2Recomp', { featured: false }),
        doc('psxrecomp', { featured: true }),
        doc('recomp-ui', { featured: false, detailPageEnabled: true, slug: { current: 'recomp-ui' } }),
      ],
    });
    const data = await buildProjectData(s);
    const bySlug = Object.fromEntries(data.pages.map((p) => [p.slug, p]));
    assert.equal(bySlug.toystory2recomp?.project.featured, false); // local record keeps the page
    assert.equal(bySlug.psxrecomp?.reason, 'featured'); // newly featured
    assert.equal(bySlug['recomp-ui']?.reason, 'sanity'); // previously activated in Sanity
    assert.ok(!data.featured.some((p) => p.name === 'ToyStory2Recomp'));
    assert.equal(data.all.find((p) => p.name === 'recomp-ui')?.detailPath, '/projects/recomp-ui/');
  });

  it('hides pages of hidden projects', async () => {
    const { s } = sources({ fetchSanityProjects: async () => [doc('romm2switch', { hidden: true })] });
    const data = await buildProjectData(s);
    assert.ok(!data.pages.some((p) => p.slug === 'romm2switch'));
  });

  it('renders Sanity detail content and reuses the Sanity card screenshot as hero', async () => {
    const { s } = sources({
      fetchSanityProjects: async () => [
        doc('ToyStory2Recomp', {
          screenshot: { alt: 'Card', asset: asset(1) },
          screenshots: [{ _key: 'g', alt: 'Card', asset: asset(1) }],
          features: [{ _key: 'f', title: 'Widescreen' }],
          videos: [{ _key: 'v', url: 'https://youtu.be/dQw4w9WgXcQ' }],
        }),
      ],
    });
    const page = (await buildProjectData(s)).pages.find((p) => p.slug === 'toystory2recomp')!;
    assert.equal(page.image?.alt, 'Card');
    assert.equal(page.details.hero?.alt, 'Card');
    assert.equal(page.details.features.length, 1);
    assert.equal(page.details.gallery.length, 1);
    assert.equal(page.details.videos[0].id, 'dQw4w9WgXcQ');
  });

  it('still creates the pages when Sanity is unavailable', async () => {
    const { s } = sources({ fetchSanityProjects: async () => Promise.reject(new Error('offline')) });
    const data = await buildProjectData(s);
    assert.equal(data.pages.length, Object.keys(detailPages).length);
    assert.ok(data.pages.every((p) => p.details.features.length === 0));
  });
});

// ── Latest release ─────────────────────────────────────────────────────────────────────────────────────────────

const apiRelease = {
  tag_name: 'v1.2.0',
  name: 'Toy Story 2 Recomp v1.2.0',
  html_url: 'https://github.com/PeriBluGaming/ToyStory2Recomp/releases/tag/v1.2.0',
  published_at: '2026-10-30T12:00:00Z',
  draft: false,
  prerelease: false,
  assets: [{ browser_download_url: 'https://example.com/x.zip' }],
};
const response = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('latest GitHub release', () => {
  it('keeps only version, name, date and the release page URL', () => {
    assert.deepEqual(normalizeRelease(apiRelease, 'PeriBluGaming', 'ToyStory2Recomp'), {
      version: 'v1.2.0',
      name: 'Toy Story 2 Recomp v1.2.0',
      publishedAt: '2026-10-30T12:00:00.000Z',
      url: 'https://github.com/PeriBluGaming/ToyStory2Recomp/releases/tag/v1.2.0',
    });
    assert.equal(normalizeRelease({ ...apiRelease, name: 'v1.2.0', published_at: null }, 'PeriBluGaming', 'ToyStory2Recomp')?.name, undefined);
  });

  it('rejects drafts, prereleases, foreign URLs and incomplete data', () => {
    for (const bad of [
      { ...apiRelease, draft: true },
      { ...apiRelease, prerelease: true },
      { ...apiRelease, html_url: 'https://evil.com/PeriBluGaming/ToyStory2Recomp/releases/tag/v1' },
      { ...apiRelease, html_url: 'https://github.com/Other/ToyStory2Recomp/releases/tag/v1' },
      { ...apiRelease, html_url: 'javascript:alert(1)' },
      { ...apiRelease, tag_name: '' },
      null,
    ]) {
      assert.equal(normalizeRelease(bad, 'PeriBluGaming', 'ToyStory2Recomp'), null);
    }
  });

  it('requests /releases/latest and returns null when there is no release (404)', async () => {
    const urls: string[] = [];
    const ok = await fetchLatestRelease('PeriBluGaming', 'ToyStory2Recomp', {
      token: 't',
      fetchImpl: (async (url: string, init: RequestInit) => {
        urls.push(url);
        assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer t');
        return response(200, apiRelease);
      }) as typeof fetch,
    });
    assert.equal(ok?.version, 'v1.2.0');
    assert.deepEqual(urls, ['https://api.github.com/repos/PeriBluGaming/ToyStory2Recomp/releases/latest']);
    assert.equal(await fetchLatestRelease('PeriBluGaming', 'NoRelease', { fetchImpl: (async () => response(404)) as unknown as typeof fetch }), null);
  });

  it('throws on API errors (the loader turns them into "no release")', async () => {
    await assert.rejects(
      fetchLatestRelease('PeriBluGaming', 'X', { fetchImpl: (async () => response(403, {}, { 'x-ratelimit-remaining': '0' })) as unknown as typeof fetch }),
      (err: unknown) => err instanceof GitHubApiError && err.rateLimited,
    );
  });

  it('loader: never fails the build, caches per repository, skips the API offline', async () => {
    const warnings: string[] = [];
    let calls = 0;
    const load = createReleaseLoader({
      owner: 'PeriBluGaming',
      env: {},
      fetchRelease: async (_o, repo) => {
        calls++;
        if (repo === 'Broken') throw new Error('socket hang up');
        return normalizeRelease(apiRelease, 'PeriBluGaming', 'ToyStory2Recomp');
      },
      log: { warn: (m: string) => warnings.push(m) },
    });
    assert.equal(await load('Broken'), null);
    assert.match(warnings[0], /Broken unavailable \(socket hang up\)/);
    assert.equal((await load('ToyStory2Recomp'))?.version, 'v1.2.0');
    await load('toystory2recomp');
    assert.equal(calls, 2);

    const offline = createReleaseLoader({ owner: 'PeriBluGaming', env: { GITHUB_OFFLINE: '1' }, fetchRelease: async () => assert.fail('no request') });
    assert.equal(await offline('ToyStory2Recomp'), null);
  });
});
