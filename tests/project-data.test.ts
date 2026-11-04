/**
 * Project data pipeline (src/lib/project-data.ts) with the real configuration, fallback snapshot and local
 * screenshot validation; GitHub and Sanity are injected.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { categories, defaultCategory, featuredProjects, listSettings, projectOverrides } from '../src/config/projects.ts';
import type { BlogConfig } from '../src/lib/blog/config.ts';
import { GitHubApiError, type RepoData } from '../src/lib/github.ts';
import { buildProjectData, type ProjectSources } from '../src/lib/project-data.ts';
import { validateProjectImage } from '../src/lib/project-image.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fallback = JSON.parse(readFileSync(join(root, 'src/data/fallback-repos.json'), 'utf8')) as { fetchedAt: string; repos: RepoData[] };
const sanity: BlogConfig = { mode: 'sanity', projectId: 'abc123xy', dataset: 'production', apiVersion: '2025-02-19', allowFailure: false };
const LOCAL_FEATURED = ['ToyStory2Recomp', 'BugsBunnyLostinTimeRecomp', 'RescueShotRecomp', 'SuperMarioWorld2YoshisIslandRecomp', 'romm2switch'];

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
    log: { warn: (m: string) => warnings.push(m) },
    ...overrides,
  };
  return { s, warnings };
}
const names = (list: { name: string }[]) => list.map((p) => p.name);

describe('buildProjectData', () => {
  it('without Sanity documents: the five configured featured projects, order and local screenshots unchanged', async () => {
    const { s, warnings } = sources();
    const data = await buildProjectData(s);
    assert.equal(data.overrides, 'sanity'); // an empty collection is valid, not an error
    assert.deepEqual(names(data.featured), LOCAL_FEATURED);
    assert.deepEqual(data.featured.map((p) => p.image?.src), featuredProjects.map((f) => f.image?.src));
    assert.deepEqual(warnings, []);
  });

  it('is identical with Sanity unconfigured, unavailable or returning garbage', async () => {
    const baseline = await buildProjectData(sources().s);
    for (const [label, partial, status] of [
      ['unconfigured', { sanityConfig: { mode: 'disabled' } as BlogConfig }, 'disabled'],
      ['sample mode', { sanityConfig: { mode: 'sample' } as BlogConfig }, 'disabled'],
      ['unavailable', { fetchSanityProjects: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) }, 'unavailable'],
      ['invalid response', { fetchSanityProjects: async () => ({ error: 'x' }) }, 'unavailable'],
    ] as const) {
      const { s, warnings } = sources(partial as Partial<ProjectSources>);
      const data = await buildProjectData(s);
      assert.equal(data.overrides, status, label);
      assert.deepEqual({ ...data, overrides: 'x', fetchedAt: 'x' }, { ...baseline, overrides: 'x', fetchedAt: 'x' }, label);
      if (status === 'unavailable') assert.match(warnings.join('\n'), /using the local project configuration/, label);
    }
  });

  it('applies Sanity overrides on top of GitHub and the local configuration', async () => {
    const { s, warnings } = sources({
      fetchSanityProjects: async () => [
        { _id: 'p1', _updatedAt: '2026-11-01T00:00:00Z', repo: 'romm2switch', featured: false },
        { _id: 'p2', _updatedAt: '2026-11-01T00:00:00Z', repo: 'PSXRECOMP', featured: true, featuredOrder: 0, title: 'PSX Recomp', screenshot: { alt: 'Recompiler output' } },
        { _id: 'p3', _updatedAt: '2026-11-01T00:00:00Z', repo: 'ToyStory2Recomp', screenshot: { alt: '' } }, // invalid → local
        { _id: 'p4', _updatedAt: '2026-11-01T00:00:00Z', repo: 'recomp-ui', hidden: true },
        { _id: 'p5', _updatedAt: '2026-11-01T00:00:00Z', repo: 'DoesNotExist', featured: true },
        { _id: 'p6', repo: '' },
      ],
    });
    const data = await buildProjectData(s);
    // psxrecomp: Sanity order 0 ties with ToyStory2Recomp's local position 0 → local position decides
    assert.deepEqual(names(data.featured), ['ToyStory2Recomp', 'psxrecomp', 'BugsBunnyLostinTimeRecomp', 'RescueShotRecomp', 'SuperMarioWorld2YoshisIslandRecomp']);
    const psx = data.featured[1];
    assert.equal(psx.title, 'PSX Recomp');
    assert.equal(psx.fork, true); // GitHub-owned; featured bypasses the fork filter
    assert.equal(psx.image?.alt, 'Recompiler output');
    assert.equal(data.featured[0].image?.src, '/images/projects/toystory2/gameplay.png');
    assert.ok(!names(data.all).includes('recomp-ui'));
    assert.ok(!names(data.all).includes('DoesNotExist'));
    assert.match(warnings.join('\n'), /invalid screenshot/);
    assert.match(warnings.join('\n'), /"DoesNotExist".*no matching public repository/);
    assert.match(warnings.join('\n'), /missing repository name/);
  });

  it('uses the GitHub fallback snapshot when the API fails, and merges Sanity overrides into it', async () => {
    const { s, warnings } = sources({
      fetchRepos: async () => Promise.reject(new GitHubApiError('GitHub API responded 403', 403, true)),
      fetchSanityProjects: async () => [{ _id: 'p', repo: 'ToyStory2Recomp', title: 'From CMS' }],
    });
    const data = await buildProjectData(s);
    assert.equal(data.source, 'fallback');
    assert.equal(data.fetchedAt, fallback.fetchedAt);
    assert.equal(data.featured[0].title, 'From CMS');
    assert.match(warnings[0], /rate limit reached.*fallback snapshot/);
  });

  it('keeps the existing fork/archive filters for non-featured projects', async () => {
    const extra: RepoData[] = [
      { name: 'OldTool', url: 'https://github.com/PeriBluGaming/OldTool', description: null, language: null, stars: 0, fork: false, archived: true, pushedAt: '2026-01-01T00:00:00Z', topics: [] },
    ];
    const data = await buildProjectData(sources({ fetchRepos: async () => [...fallback.repos, ...extra] }).s);
    assert.ok(!names(data.all).includes('OldTool')); // hideArchived
    assert.ok(names(data.all).includes('psxrecomp')); // forks are listed (hideForks: false)
  });

  it('fails the build for a misconfigured local screenshot, as before', async () => {
    const broken = featuredProjects.map((f, i) => (i === 0 ? { ...f, image: { ...f.image!, src: '/images/projects/missing.webp' } } : f));
    const { s } = sources();
    await assert.rejects(buildProjectData({ ...s, config: { ...s.config, featuredProjects: broken } }), /file not found/);
  });
});
