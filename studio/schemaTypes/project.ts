import { defineArrayMember, defineField, defineType } from 'sanity';
import { categories, type Accent } from '../../src/config/projects.ts';
import {
  MAX_TAGS,
  REPO_MAX_LENGTH,
  featuredOrderHint,
  validateAlt,
  validateRepoName,
  validateTag,
  validateTags,
  validateUniqueRepo,
} from './projectRules.ts';

/** Same accents as the website (src/config/projects.ts); the type check fails if one is missing or unknown. */
const accents = ['cyan', 'pink', 'violet'] as const satisfies readonly Accent[];
type MissingAccent = Exclude<Accent, (typeof accents)[number]>;
const allAccentsListed: [MissingAccent] extends [never] ? true : never = true;
void allAccentsListed;

/**
 * Editorial overrides for a GitHub repository, matched by `repo`.
 *
 * GitHub stays the source of truth for which repositories exist and for technical metadata (language, stars, dates).
 * A project document is optional – repositories without one keep their defaults. Every override field is optional;
 * an unset field means "no override" (keep the website's default), which is why `featured` has no initial value:
 * unset and an explicit `false` must stay distinguishable when the website merges overrides later.
 * The website does not read these documents yet.
 */
export const project = defineType({
  name: 'project',
  title: 'Project',
  type: 'document',
  groups: [
    { name: 'content', title: 'Content', default: true },
    { name: 'display', title: 'Display' },
    { name: 'media', title: 'Screenshots' },
  ],
  fields: [
    defineField({
      name: 'repo',
      title: 'GitHub repository',
      type: 'string',
      group: 'content',
      description: `Repository name below github.com/PeriBluGaming/ (e.g. ToyStory2Recomp). Unique, case-insensitive.`,
      validation: (r) =>
        r
          .required()
          .max(REPO_MAX_LENGTH)
          .custom(validateRepoName)
          .custom((value, context) =>
            validateUniqueRepo(value, context.document?._id, context.getClient({ apiVersion: '2025-02-19' })),
          ),
    }),
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      group: 'content',
      description: 'Optional. Overrides the repository name on the website.',
      validation: (r) => r.max(100),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 3,
      group: 'content',
      description: 'Optional. Overrides the GitHub description.',
      validation: (r) => r.max(300),
    }),
    defineField({
      name: 'category',
      title: 'Category',
      type: 'string',
      group: 'content',
      description: 'Optional. Unset = category from the website configuration.',
      options: { list: categories.map((c) => ({ title: c.label, value: c.id })) },
    }),
    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      group: 'content',
      description: `Optional, at most ${MAX_TAGS} (e.g. "PS1", "Recomp").`,
      of: [defineArrayMember({ type: 'string', validation: (r) => r.custom(validateTag) })],
      options: { layout: 'tags' },
      validation: (r) => r.custom(validateTags),
    }),
    defineField({
      name: 'hidden',
      title: 'Hide on website',
      type: 'boolean',
      group: 'display',
      description: 'Only projects with this switched on are left out.',
      initialValue: false,
    }),
    defineField({
      name: 'featured',
      title: 'Featured',
      type: 'boolean',
      group: 'display',
      description: 'Optional. Unset = keep the website default; on/off overrides it explicitly.',
    }),
    defineField({
      name: 'featuredOrder',
      title: 'Featured order',
      type: 'number',
      group: 'display',
      description: 'Optional. Lower numbers come first among featured projects.',
      validation: (r) => [
        r.integer().min(0),
        r.custom((value, context) => featuredOrderHint(value, context.document?.featured)).warning(),
      ],
    }),
    defineField({
      name: 'accent',
      title: 'Accent colour',
      type: 'string',
      group: 'display',
      description: 'Optional. Card border colour when featured.',
      options: { list: [...accents], layout: 'radio', direction: 'horizontal' },
    }),
    defineField({
      name: 'screenshots',
      title: 'Screenshots',
      type: 'array',
      group: 'media',
      description:
        'Optional. The first screenshot is used on the featured card: it fills the left art area and is cropped, so set the hotspot on the subject. 16:9, at least 1280 × 720.',
      of: [
        defineArrayMember({
          type: 'image',
          options: { hotspot: true },
          fields: [
            defineField({
              name: 'alt',
              title: 'Alternative text',
              type: 'string',
              description: 'What the screenshot shows, in one short sentence.',
              validation: (r) => r.required().custom(validateAlt),
            }),
          ],
        }),
      ],
    }),
  ],
  orderings: [
    { title: 'Repository A–Z', name: 'repoAsc', by: [{ field: 'repo', direction: 'asc' }] },
    {
      title: 'Featured first',
      name: 'featuredFirst',
      by: [
        { field: 'featured', direction: 'desc' },
        { field: 'featuredOrder', direction: 'asc' },
        { field: 'repo', direction: 'asc' },
      ],
    },
  ],
  preview: {
    select: {
      repo: 'repo',
      title: 'title',
      featured: 'featured',
      featuredOrder: 'featuredOrder',
      hidden: 'hidden',
      media: 'screenshots.0',
    },
    prepare: ({ repo, title, featured, featuredOrder, hidden, media }) => ({
      title: title || repo || 'New project',
      subtitle: projectSubtitle({ repo, title, featured, featuredOrder, hidden }),
      media,
    }),
  },
});

/** Preview subtitle: repository (if a title overrides it) plus featured / hidden state. Exported for tests. */
export function projectSubtitle(p: { repo?: string; title?: string; featured?: boolean; featuredOrder?: number; hidden?: boolean }): string {
  const parts: string[] = [];
  if (p.title && p.repo) parts.push(p.repo);
  if (p.featured === true) parts.push(typeof p.featuredOrder === 'number' ? `★ Featured #${p.featuredOrder}` : '★ Featured');
  if (p.featured === false) parts.push('Not featured');
  if (p.hidden) parts.push('Hidden');
  return parts.join(' · ');
}
