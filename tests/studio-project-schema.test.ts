/**
 * Sanity `project` schema (studio/schemaTypes/project.ts): registration, fields, Studio navigation and validation.
 *
 * The pure rules run everywhere. The schema tests load the real Studio schema and run Sanity's own validation
 * engine; they need the Studio dependencies (`cd studio && npm ci`) and are reported as skipped without them.
 * Studio modules are imported dynamically so `astro check` doesn't type-check the Studio with the site's config.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  PROJECT_REPOS_QUERY,
  baseDocumentId,
  featuredOrderHint,
  repoKey,
  validateAlt,
  validateRepoName,
  validateTags,
  validateUniqueRepo,
} from '../studio/schemaTypes/projectRules.ts';

const studioUrl = new URL('../studio/', import.meta.url);
const studioReady = existsSync(new URL('node_modules/sanity/package.json', studioUrl));
const skip = studioReady ? false : 'Studio dependencies not installed (cd studio && npm ci)';

type Doc = { _id: string; repo: string };
const lookup = (docs: unknown, calls: unknown[][] = []) => ({
  fetch: async (...args: unknown[]) => {
    calls.push(args);
    return docs;
  },
});
const failing = { fetch: async () => Promise.reject(new Error('Request timed out')) };

describe('project rules: repository name', () => {
  it('accepts GitHub repository names', () => {
    for (const repo of ['ToyStory2Recomp', 'recomp-ui', 'PeriBluGaming.github.io', 'snes_tools', 'a'.repeat(100)]) {
      assert.equal(validateRepoName(repo), true, repo);
    }
  });

  it('rejects invalid characters, surrounding spaces, dot names and over-long names', () => {
    for (const repo of ['Toy Story 2', ' ToyStory2Recomp', 'ToyStory2Recomp ', 'Peri/Blu', 'Spiel-ä', '.', '..', 'a'.repeat(101)]) {
      assert.equal(typeof validateRepoName(repo), 'string', repo);
    }
  });

  it('leaves missing values to required()', () => {
    assert.equal(validateRepoName(undefined), true);
    assert.equal(validateRepoName(''), true);
  });

  it('compares case-insensitively and ignores surrounding whitespace', () => {
    assert.equal(repoKey(' ToyStory2Recomp '), repoKey('toystory2recomp'));
  });
});

describe('project rules: duplicate repositories', () => {
  it('maps drafts and release versions to the same document', () => {
    assert.equal(baseDocumentId('drafts.p1'), 'p1');
    assert.equal(baseDocumentId('versions.rABC.p1'), 'p1');
    assert.equal(baseDocumentId('p1'), 'p1');
  });

  it('queries all project documents with the raw perspective (drafts included)', async () => {
    const calls: unknown[][] = [];
    assert.equal(await validateUniqueRepo('ToyStory2Recomp', 'drafts.p1', lookup([], calls)), true);
    assert.deepEqual(calls, [[PROJECT_REPOS_QUERY, {}, { perspective: 'raw' }]]);
  });

  it('detects a published project with the same name, case-insensitively', async () => {
    const docs: Doc[] = [{ _id: 'p2', repo: 'ToyStory2Recomp' }];
    assert.match(String(await validateUniqueRepo('toystory2recomp', 'drafts.p1', lookup(docs))), /already used by a published project \(p2\)/);
  });

  it('detects another document that only exists as a draft or release version', async () => {
    assert.match(String(await validateUniqueRepo('X', 'p1', lookup([{ _id: 'drafts.p2', repo: 'x' }]))), /unpublished draft \(p2\)/);
    assert.match(String(await validateUniqueRepo('X', 'p1', lookup([{ _id: 'versions.r1.p3', repo: 'X' }]))), /\(p3\)/);
  });

  it('does not report the draft, published or release version of the same document', async () => {
    const own: Doc[] = [
      { _id: 'p1', repo: 'ToyStory2Recomp' },
      { _id: 'drafts.p1', repo: 'toystory2recomp' },
      { _id: 'versions.r1.p1', repo: 'TOYSTORY2RECOMP' },
    ];
    for (const id of ['p1', 'drafts.p1', 'versions.r1.p1']) {
      assert.equal(await validateUniqueRepo('ToyStory2Recomp', id, lookup(own)), true, id);
    }
  });

  it('checks new documents without an id against all others', async () => {
    assert.equal(typeof (await validateUniqueRepo('X', undefined, lookup([{ _id: 'p2', repo: 'x' }]))), 'string');
  });

  it('fails closed with a clear message when the lookup fails or returns garbage', async () => {
    assert.match(String(await validateUniqueRepo('X', 'p1', failing)), /Could not check .* \(Request timed out\).*publishing stays blocked/);
    assert.match(String(await validateUniqueRepo('X', 'p1', lookup({ error: 'x' }))), /unexpected response/);
  });

  it('skips the lookup for invalid or empty names (other rules report them)', async () => {
    const calls: unknown[][] = [];
    assert.equal(await validateUniqueRepo('Toy Story', 'p1', lookup([], calls)), true);
    assert.equal(await validateUniqueRepo(undefined, 'p1', lookup([], calls)), true);
    assert.equal(calls.length, 0);
  });
});

describe('project rules: tags, alt text, featured order', () => {
  it('allows up to two unique, non-empty tags', () => {
    assert.equal(validateTags(undefined), true);
    assert.equal(validateTags([]), true);
    assert.equal(validateTags(['PS1', 'Recomp']), true);
    assert.match(String(validateTags(['a', 'b', 'c'])), /At most 2/);
    assert.match(String(validateTags(['PS1', ''])), /must not be empty/);
    assert.match(String(validateTags(['   '])), /must not be empty/);
    assert.match(String(validateTags([' PS1'])), /spaces/);
    assert.match(String(validateTags(['PS1', 'ps1'])), /unique/);
  });

  it('requires real alternative text', () => {
    assert.equal(validateAlt('Buzz Lightyear in Andy’s room'), true);
    assert.equal(typeof validateAlt('   '), 'string');
    assert.equal(validateAlt(undefined), true); // required() reports missing alt text
  });

  it('hints when an order is set on a project that is not featured', () => {
    assert.equal(featuredOrderHint(undefined, undefined), true);
    assert.equal(featuredOrderHint(1, true), true);
    assert.equal(typeof featuredOrderHint(1, undefined), 'string');
    assert.equal(typeof featuredOrderHint(1, false), 'string');
  });
});

describe('project schema (Sanity)', { skip }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sanity: any, types: any[], project: any, post: any, projectSubtitle: any, structure: any, schema: any, categories: any[];

  before(async () => {
    const entry = createRequire(new URL('package.json', studioUrl)).resolve('sanity');
    sanity = await import(pathToFileURL(entry).href);
    ({ schemaTypes: types } = await import(new URL('schemaTypes/index.ts', studioUrl).href));
    ({ project, projectSubtitle } = await import(new URL('schemaTypes/project.ts', studioUrl).href));
    ({ post } = await import(new URL('schemaTypes/post.ts', studioUrl).href));
    ({ structure } = await import(new URL('structure.ts', studioUrl).href));
    ({ categories } = await import(new URL('../src/config/projects.ts', import.meta.url).href));
    schema = sanity.createSchema({ name: 'default', types });
  });

  const field = (name: string) => project.fields.find((f: { name: string }) => f.name === name);

  type Marker = { level: string; path: string; message: string };

  /** Runs Sanity's real document validation. `existing` = project documents the duplicate lookup returns. */
  async function validate(doc: Record<string, unknown>, existing: unknown = [], type = 'project'): Promise<Marker[]> {
    const client = {
      fetch: async () => (existing instanceof Error ? Promise.reject(existing) : existing),
      withConfig() {
        return client;
      },
      getDataUrl: () => '',
      request: async () => ({}),
      observable: { fetch: () => { throw new Error('not used'); } },
    };
    const i18n = { t: (key: string) => key, loadNamespaces: async () => {}, locales: [], loadedLocales: {} };
    const markers = await sanity.validateDocument({
      document: { _id: 'drafts.p1', _type: type, ...doc },
      workspace: { schema, getClient: () => client, i18n },
      getDocumentExists: async () => true,
      environment: 'studio',
    });
    return markers.map((m: { level: string; path: unknown[]; message?: string; item?: { message?: string } }) => ({
      level: m.level,
      path: m.path.map((p) => (typeof p === 'object' && p !== null && '_key' in p ? '[]' : String(p))).join('.'),
      message: String(m.message ?? m.item?.message),
    }));
  }
  const errorsAt = async (doc: Record<string, unknown>, existing?: unknown) =>
    (await validate(doc, existing)).filter((m) => m.level === 'error').map((m) => m.path);

  const image = (alt?: string) => ({ _key: 'k1', _type: 'image', asset: { _type: 'reference', _ref: 'image-abc123-1280x720-webp' }, ...(alt !== undefined && { alt }) });

  describe('registration', () => {
    it('registers project next to the existing types', () => {
      assert.deepEqual(types.map((t: { name: string }) => t.name), ['post', 'project', 'blockContent', 'codeBlock']);
      assert.equal(schema.get('project')?.name, 'project');
      assert.equal(schema.get('post')?.name, 'post');
    });

    it('adds a Projects entry to the Studio navigation and keeps Blog posts unchanged', () => {
      const make = (kind: string, arg?: unknown) => {
        const rec: Record<string, unknown> = { kind, arg };
        const proxy: Record<string, unknown> = new Proxy(rec, {
          get: (t, k: string) => (k in t ? t[k] : (value: unknown) => ((t[k] = value), proxy)),
        });
        return proxy;
      };
      const S = { list: () => make('list'), listItem: () => make('listItem'), documentTypeList: (type: string) => make('documentTypeList', type) };
      const root = structure(S, {});
      const items = root.items as Record<string, Record<string, unknown>>[];
      assert.equal(root.title, 'Content');
      assert.deepEqual(items.map((i) => [i.title, i.schemaType]), [['Blog posts', 'post'], ['Projects', 'project']]);
      assert.deepEqual(items[0].child.defaultOrdering, [{ field: 'publishedAt', direction: 'desc' }]);
      assert.equal(items[1].child.arg, 'project');
      assert.deepEqual((items[1].child.defaultOrdering as { field: string }[]).map((o) => o.field), ['featured', 'featuredOrder', 'repo']);
    });

    it('offers orderings by repository and featured order', () => {
      assert.deepEqual(project.orderings.map((o: { name: string }) => o.name), ['repoAsc', 'featuredFirst']);
    });
  });

  describe('fields', () => {
    it('has exactly the agreed fields', () => {
      assert.deepEqual(
        project.fields.map((f: { name: string; type: string }) => `${f.name}:${f.type}`),
        ['repo:string', 'title:string', 'description:text', 'category:string', 'tags:array', 'hidden:boolean', 'featured:boolean', 'featuredOrder:number', 'accent:string', 'screenshots:array'],
      );
    });

    it('reuses the website categories and accents', () => {
      assert.deepEqual(field('category').options.list.map((o: { value: string }) => o.value), categories.map((c) => c.id));
      assert.deepEqual(field('accent').options.list, ['cyan', 'pink', 'violet']);
      assert.deepEqual([...new Set(categories.map((c) => c.accent))].sort(), ['cyan', 'pink', 'violet']);
    });

    it('defaults hidden to false and leaves featured unset (unset ≠ explicit false)', () => {
      assert.equal(field('hidden').initialValue, false);
      assert.equal('initialValue' in field('featured'), false);
      assert.equal('initialValue' in field('accent'), false);
      assert.equal('initialValue' in field('category'), false);
    });

    it('uses hotspot images with an alt field for screenshots', () => {
      const [member] = field('screenshots').of;
      assert.equal(member.type, 'image');
      assert.equal(member.options.hotspot, true);
      assert.deepEqual(member.fields.map((f: { name: string }) => f.name), ['alt']);
    });
  });

  describe('validation (Sanity engine)', () => {
    it('requires only the repository – every override is optional', async () => {
      assert.deepEqual(await errorsAt({}), ['repo']);
      assert.deepEqual(await validate({ repo: 'ToyStory2Recomp' }), []);
    });

    it('accepts a fully overridden project', async () => {
      const doc = {
        repo: 'ToyStory2Recomp',
        title: 'Toy Story 2 Recomp',
        description: 'Native recompilation with modern camera, widescreen and more.',
        category: 'playstation',
        tags: ['PS1', 'Recomp'],
        hidden: false,
        featured: true,
        featuredOrder: 0,
        accent: 'cyan',
        screenshots: [image('Buzz Lightyear exploring Andy’s room in widescreen.')],
      };
      assert.deepEqual(await validate(doc), []);
      assert.deepEqual(await validate({ ...doc, featured: false, featuredOrder: undefined }), []);
    });

    it('rejects invalid repository names', async () => {
      assert.deepEqual(await errorsAt({ repo: 'Toy Story 2' }), ['repo']);
      assert.deepEqual(await errorsAt({ repo: 'ToyStory2Recomp ' }), ['repo']);
    });

    it('rejects a repository already used by another project, case-insensitively', async () => {
      const markers = await validate({ repo: 'toystory2recomp' }, [{ _id: 'p2', repo: 'ToyStory2Recomp' }]);
      assert.deepEqual(markers.map((m) => [m.level, m.path]), [['error', 'repo']]);
      assert.match(markers[0].message, /already used/);
      assert.deepEqual(await validate({ repo: 'ToyStory2Recomp' }, [{ _id: 'p1', repo: 'ToyStory2Recomp' }]), []); // own published version
    });

    it('blocks publishing with a clear message when the duplicate check cannot run', async () => {
      const markers = await validate({ repo: 'ToyStory2Recomp' }, new Error('Network request failed'));
      assert.deepEqual(markers.map((m) => [m.level, m.path]), [['error', 'repo']]);
      assert.match(markers[0].message, /Could not check .*Network request failed/);
    });

    it('validates tags', async () => {
      assert.deepEqual(await errorsAt({ repo: 'X', tags: ['a', 'b', 'c'] }), ['tags']);
      assert.deepEqual(await errorsAt({ repo: 'X', tags: ['PS1', ' '] }), ['tags', 'tags.1']);
    });

    it('requires alternative text for every screenshot', async () => {
      assert.deepEqual(await errorsAt({ repo: 'X', screenshots: [image()] }), ['screenshots.[].alt']);
      assert.deepEqual(await errorsAt({ repo: 'X', screenshots: [image('   ')] }), ['screenshots.[].alt']);
      assert.deepEqual(await errorsAt({ repo: 'X', screenshots: [image('Title screen')] }), []);
    });

    it('accepts only non-negative whole numbers as featured order, with a hint when not featured', async () => {
      assert.deepEqual(await errorsAt({ repo: 'X', featured: true, featuredOrder: 1.5 }), ['featuredOrder']);
      assert.deepEqual(await errorsAt({ repo: 'X', featured: true, featuredOrder: -1 }), ['featuredOrder']);
      assert.deepEqual(await validate({ repo: 'X', featured: true, featuredOrder: 2 }), []);
      assert.deepEqual((await validate({ repo: 'X', featuredOrder: 2 })).map((m) => [m.level, m.path]), [['warning', 'featuredOrder']]);
    });
  });

  describe('preview', () => {
    it('shows title or repository plus the featured / hidden state', () => {
      const prepare = project.preview.prepare;
      assert.deepEqual(prepare({ repo: 'ToyStory2Recomp' }), { title: 'ToyStory2Recomp', subtitle: '', media: undefined });
      assert.equal(prepare({ repo: 'ToyStory2Recomp', title: 'Toy Story 2 Recomp' }).subtitle, 'ToyStory2Recomp');
      assert.equal(projectSubtitle({ repo: 'r', title: 't', featured: true, featuredOrder: 1 }), 'r · ★ Featured #1');
      assert.equal(projectSubtitle({ repo: 'r', featured: true }), '★ Featured');
      assert.equal(projectSubtitle({ repo: 'r', featured: false, hidden: true }), 'Not featured · Hidden');
      assert.equal(projectSubtitle({ repo: 'r' }), ''); // unset featured shows nothing
      assert.equal(project.preview.select.media, 'screenshots.0');
    });
  });

  describe('blog compatibility', () => {
    it('keeps the post type unchanged and a published post valid', async () => {
      assert.equal(post.name, 'post');
      const markers = await validate(
        {
          title: 'Hello',
          slug: { _type: 'slug', current: 'hello' },
          excerpt: 'First post.',
          category: 'devlog',
          publishedAt: '2026-11-01T10:00:00Z',
          language: 'en',
          coverImage: { _type: 'image', asset: { _type: 'reference', _ref: 'image-abc123-1600x900-webp' }, alt: 'Cover' },
          body: [{ _key: 'b1', _type: 'block', style: 'normal', markDefs: [], children: [{ _key: 's1', _type: 'span', text: 'Hi', marks: [] }] }],
        },
        [],
        'post',
      );
      assert.deepEqual(markers.filter((m) => m.level === 'error'), []);
    });
  });
});
