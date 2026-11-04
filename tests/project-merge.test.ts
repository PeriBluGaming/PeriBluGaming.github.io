/**
 * Merging GitHub repositories with Sanity overrides and the local configuration (src/lib/project-merge.ts).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Category, FeaturedEntry, ProjectImage } from '../src/config/projects.ts';
import type { RepoData } from '../src/lib/github.ts';
import {
  mergeProjects,
  normalizeSanityProject,
  selectOverrides,
  type EditorialOverride,
  type MergeConfig,
} from '../src/lib/project-merge.ts';

const categories: Category[] = [
  { id: 'playstation', label: 'PlayStation', accent: 'cyan', art: 'disc' },
  { id: 'nintendo', label: 'Nintendo / SNES', accent: 'violet', art: 'cartridge' },
  { id: 'homebrew', label: 'Homebrew', accent: 'pink', art: 'handheld' },
  { id: 'tools', label: 'Tools', accent: 'cyan', art: 'code' },
  { id: 'other', label: 'Other', accent: 'violet', art: 'code' },
];
const localShot: ProjectImage = { src: '/images/projects/a/shot.webp', alt: 'Local A', position: 'center' };
const sanityShot: ProjectImage = { src: 'https://cdn.sanity.io/images/p/production/x.webp', alt: 'Sanity A', position: '30% 40%' };

const featuredProjects: FeaturedEntry[] = [
  { repo: 'Alpha', accent: 'pink', image: localShot },
  { repo: 'Beta', accent: 'cyan' },
];
const config = (overrides: Partial<MergeConfig> = {}): MergeConfig => ({
  categories,
  defaultCategory: 'other',
  projectOverrides: {
    Alpha: { title: 'Alpha Local', description: 'Local alpha', category: 'playstation', tags: ['PS1', 'Recomp'] },
    Beta: { title: 'Beta Local', category: 'nintendo' },
    Hidden: { hidden: true },
  },
  featuredProjects,
  listSettings: { hideForks: false, hideArchived: true, exclude: ['PeriBluGaming.github.io'] },
  ...overrides,
});

const repo = (name: string, extra: Partial<RepoData> = {}): RepoData => ({
  name,
  url: `https://github.com/PeriBluGaming/${name}`,
  description: `${name} on GitHub`,
  language: 'C',
  stars: 3,
  fork: false,
  archived: false,
  pushedAt: '2026-10-01T00:00:00Z',
  topics: [],
  ...extra,
});
const repos = [
  repo('Alpha', { pushedAt: '2026-01-01T00:00:00Z' }),
  repo('Beta', { pushedAt: '2026-02-01T00:00:00Z' }),
  repo('Gamma', { pushedAt: '2026-03-01T00:00:00Z', description: null }),
  repo('Delta', { pushedAt: '2026-04-01T00:00:00Z', fork: true }),
  repo('Old', { archived: true }),
  repo('Hidden'),
  repo('PeriBluGaming.github.io'),
];

const ov = (repoName: string, fields: Partial<EditorialOverride> = {}): EditorialOverride => ({
  repo: repoName,
  sourceId: `id-${repoName}`,
  updatedAt: '2026-11-01T00:00:00Z',
  ...fields,
});
const byKey = (...list: EditorialOverride[]) => selectOverrides(list).byKey;
const merge = (overrides = byKey(), cfg = config()) =>
  mergeProjects({ repos, overrides, config: cfg, resolveLocalImage: (image) => image });
const names = (list: { name: string }[]) => list.map((p) => p.name);

describe('mergeProjects without Sanity overrides (local configuration unchanged)', () => {
  const result = merge();

  it('keeps the configured featured projects, order and accents', () => {
    assert.deepEqual(names(result.featured), ['Alpha', 'Beta']);
    assert.deepEqual(result.featured.map((p) => p.accent), ['pink', 'cyan']);
    assert.deepEqual(result.featured[0].image, localShot);
    assert.equal(result.featured[1].image, undefined);
  });

  it('lists featured first, then by push date; applies hidden, exclude and the fork/archive filters', () => {
    assert.deepEqual(names(result.all), ['Alpha', 'Beta', 'Delta', 'Gamma']); // Old archived, Hidden hidden, site repo excluded
  });

  it('uses the GitHub repository as-is when there is no override at all', () => {
    const gamma = result.all.find((p) => p.name === 'Gamma')!;
    assert.deepEqual(
      { title: gamma.title, description: gamma.description, category: gamma.category.id, tags: gamma.tags, featured: gamma.featured },
      { title: 'Gamma', description: null, category: 'other', tags: [], featured: false },
    );
  });
});

describe('editorial precedence: Sanity → local → GitHub', () => {
  it('Sanity overrides title, description, category and tags per field', () => {
    const alpha = merge(byKey(ov('Alpha', { title: 'Alpha CMS', tags: ['CMS'] }))).all.find((p) => p.name === 'Alpha')!;
    assert.equal(alpha.title, 'Alpha CMS');
    assert.deepEqual(alpha.tags, ['CMS']);
    assert.equal(alpha.description, 'Local alpha'); // not set in Sanity → local
    assert.equal(alpha.category.id, 'playstation');

    const gamma = merge(byKey(ov('Gamma', { description: 'From CMS', category: 'tools' }))).all.find((p) => p.name === 'Gamma')!;
    assert.equal(gamma.title, 'Gamma'); // GitHub fallback
    assert.equal(gamma.description, 'From CMS');
    assert.equal(gamma.category.id, 'tools');
  });

  it('keeps explicit empty values: no tags, no description', () => {
    const alpha = merge(byKey(ov('Alpha', { tags: [], description: null }))).all.find((p) => p.name === 'Alpha')!;
    assert.deepEqual(alpha.tags, []);
    assert.equal(alpha.description, null);
  });

  it('never overrides GitHub-owned fields', () => {
    const before = merge().all.find((p) => p.name === 'Gamma')!;
    const after = merge(byKey(ov('Gamma', { title: 'X', featured: true }))).all.find((p) => p.name === 'Gamma')!;
    for (const field of ['name', 'url', 'stars', 'language', 'pushedAt', 'fork', 'archived'] as const) {
      assert.deepEqual(after[field], before[field], field);
    }
  });
});

describe('featured', () => {
  it('featured: true adds a repository (with its category accent)', () => {
    const r = merge(byKey(ov('Gamma', { featured: true })));
    assert.deepEqual(names(r.featured), ['Alpha', 'Beta', 'Gamma']);
    assert.equal(r.featured[2].accent, 'violet'); // category "other"
  });

  it('featured: false removes a configured featured project; unset keeps the configuration', () => {
    assert.deepEqual(names(merge(byKey(ov('Alpha', { featured: false }))).featured), ['Beta']);
    assert.deepEqual(names(merge(byKey(ov('Alpha', { title: 'x' }))).featured), ['Alpha', 'Beta']);
  });

  it('featuredOrder controls the order; local position and name break ties deterministically', () => {
    const r = merge(byKey(ov('Beta', { featuredOrder: 0 }), ov('Gamma', { featured: true, featuredOrder: 0 }), ov('Delta', { featured: true })));
    // Alpha: local 0, Beta: Sanity 0 (local 1), Gamma: Sanity 0 (no local), Delta: no order
    assert.deepEqual(names(r.featured), ['Alpha', 'Beta', 'Gamma', 'Delta']);
    const ties = merge(byKey(ov('Gamma', { featured: true }), ov('Delta', { featured: true })), config({ featuredProjects: [] }));
    assert.deepEqual(names(ties.featured), ['Delta', 'Gamma']); // no order at all → by name
  });

  it('featured projects bypass the fork/archive filters', () => {
    const r = merge(byKey(ov('Old', { featured: true })));
    assert.ok(names(r.featured).includes('Old'));
    assert.ok(names(r.all).includes('Old'));
  });

  it('Sanity accent and screenshot win; an absent Sanity screenshot falls back to the local one', () => {
    const withShot = merge(byKey(ov('Alpha', { accent: 'violet', image: sanityShot }))).featured[0];
    assert.equal(withShot.accent, 'violet');
    assert.deepEqual(withShot.image, sanityShot);
    assert.deepEqual(merge(byKey(ov('Alpha', { accent: 'violet' }))).featured[0].image, localShot);
  });

  it('still validates local screenshots when Sanity provides one (a broken config fails the build)', () => {
    assert.throws(() =>
      mergeProjects({
        repos,
        overrides: byKey(ov('Alpha', { image: sanityShot })),
        config: config(),
        resolveLocalImage: () => {
          throw new Error('file not found');
        },
      }),
    );
  });
});

describe('hidden', () => {
  it('explicitly hidden projects disappear from featured and all projects', () => {
    const r = merge(byKey(ov('Alpha', { hidden: true }), ov('Gamma', { hidden: true, featured: true })));
    assert.ok(!names(r.featured).includes('Alpha') && !names(r.featured).includes('Gamma'));
    assert.ok(!names(r.all).includes('Alpha') && !names(r.all).includes('Gamma'));
  });

  it('hidden: false in Sanity overrides a locally hidden project', () => {
    assert.ok(names(merge(byKey(ov('Hidden', { hidden: false }))).all).includes('Hidden'));
  });

  it('configuration exclusions stay absolute', () => {
    assert.ok(!names(merge(byKey(ov('PeriBluGaming.github.io', { hidden: false, featured: true }))).all).includes('PeriBluGaming.github.io'));
  });
});

describe('matching', () => {
  it('matches case-insensitively and trims whitespace', () => {
    const { override } = normalizeSanityProject({ _id: 'p', repo: '  alpha ', title: 'Matched' }, { categoryIds: new Set(['other']), resolveImage: () => null });
    assert.equal(merge(byKey(override!)).all.find((p) => p.name === 'Alpha')!.title, 'Matched');
  });

  it('ignores documents for unknown repositories and never creates cards', () => {
    const r = merge(byKey(ov('NotOnGitHub', { featured: true, title: 'Ghost' })));
    assert.ok(!names(r.all).includes('NotOnGitHub'));
    assert.match(r.warnings.join('\n'), /"NotOnGitHub".*no matching public repository/);
  });

  it('resolves duplicates deterministically: most recently updated wins, then document id – independent of order', () => {
    const older = ov('Alpha', { sourceId: 'a1', updatedAt: '2026-10-01T00:00:00Z', title: 'Older' });
    const newer = ov('alpha', { sourceId: 'a2', updatedAt: '2026-11-01T00:00:00Z', title: 'Newer' });
    for (const list of [[older, newer], [newer, older]]) {
      const { byKey: map, warnings } = selectOverrides(list);
      assert.equal(map.size, 1);
      assert.equal(map.get('alpha')!.title, 'Newer');
      assert.match(warnings[0], /2 project documents for "alpha".*using a2.*ignoring a1/);
    }
    const tieA = ov('Alpha', { sourceId: 'b', title: 'B' });
    const tieB = ov('Alpha', { sourceId: 'a', title: 'A' });
    assert.equal(selectOverrides([tieA, tieB]).byKey.get('alpha')!.title, 'A');
    assert.equal(names(merge(byKey(older, newer)).all).filter((n) => n === 'Alpha').length, 1); // no duplicate cards
  });
});

describe('normalizeSanityProject', () => {
  const opts = { categoryIds: new Set(categories.map((c) => c.id)), resolveImage: (shot: unknown) => (shot === 'ok' ? sanityShot : null) };

  it('keeps valid fields and explicit false / empty values', () => {
    const { override, warnings } = normalizeSanityProject(
      { _id: 'p1', _updatedAt: 'u', repo: 'Alpha', title: ' T ', description: '  ', category: 'tools', tags: [' PS1 '], hidden: false, featured: false, featuredOrder: 0, accent: 'pink', screenshot: 'ok' },
      opts,
    );
    assert.deepEqual(warnings, []);
    assert.deepEqual(override, {
      repo: 'Alpha', sourceId: 'p1', updatedAt: 'u', title: 'T', description: null, category: 'tools', tags: ['PS1'],
      hidden: false, featured: false, featuredOrder: 0, accent: 'pink', image: sanityShot,
    });
  });

  it('drops invalid fields individually (they fall back) and warns', () => {
    const { override, warnings } = normalizeSanityProject(
      { _id: 'p1', repo: 'Alpha', title: '', category: 'unknown', tags: 'PS1', hidden: 'yes', featured: 1, featuredOrder: -1, accent: 'red', screenshot: 'broken', description: 42 },
      opts,
    );
    assert.deepEqual(Object.keys(override!).sort(), ['repo', 'sourceId', 'updatedAt']);
    const fields = ['title', 'description', 'category', 'tags', 'hidden', 'featured', 'featuredOrder', 'accent', 'screenshot'];
    assert.deepEqual(warnings.map((w) => /invalid (\w+)/.exec(w)?.[1]).sort(), fields.sort());
    assert.equal(normalizeSanityProject({ _id: 'p', repo: 'A', featuredOrder: 1.5 }, opts).override!.featuredOrder, undefined);
  });

  it('cleans up tags (empty values removed, max two)', () => {
    const { override, warnings } = normalizeSanityProject({ _id: 'p', repo: 'A', tags: ['a', '', 'b', 'c'] }, opts);
    assert.deepEqual(override!.tags, ['a', 'b']);
    assert.equal(warnings.length, 1);
  });

  it('skips documents without a usable repository name', () => {
    for (const raw of [null, 'x', {}, { _id: 'p', repo: '   ' }, { _id: 'p', repo: 7 }]) {
      assert.equal(normalizeSanityProject(raw, opts).override, null);
    }
  });

  it('treats null fields as unset', () => {
    const { override, warnings } = normalizeSanityProject({ _id: 'p', repo: 'A', title: null, featured: null, screenshot: null }, opts);
    assert.deepEqual(warnings, []);
    assert.equal('featured' in override!, false);
  });
});
