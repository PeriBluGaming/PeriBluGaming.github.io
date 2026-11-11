import { defineArrayMember, defineField, defineType } from 'sanity';
import { categories, detailPages, featureIcons, type Accent } from '../../src/config/projects.ts';
import { slugifyProjectName } from '../../src/lib/project-slug.ts';
import {
  MAX_TAGS,
  REPO_MAX_LENGTH,
  featuredOrderHint,
  validateAlt,
  validateRepoName,
  validateTag,
  validateTags,
  validateProjectSlug,
  validateUniqueRepo,
  validateUniqueSlug,
  validateYouTubeUrl,
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
 * The website merges published documents at build time (src/lib/project-merge.ts).
 */
export const project = defineType({
  name: 'project',
  title: 'Project',
  type: 'document',
  groups: [
    { name: 'content', title: 'Content', default: true },
    { name: 'display', title: 'Display' },
    { name: 'media', title: 'Screenshots' },
    { name: 'page', title: 'Detail page' },
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
        'Optional. The first screenshot is used on the featured card and as the detail page hero: it is cropped, so set the hotspot on the subject. All screenshots form the gallery on the detail page. 16:9, at least 1280 × 720.',
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
            defineField({
              name: 'caption',
              title: 'Caption',
              type: 'string',
              description: 'Optional. Shown below the screenshot in the detail page gallery.',
              validation: (r) => r.max(200),
            }),
          ],
        }),
      ],
    }),
    defineField({
      name: 'slug',
      title: 'Page URL',
      type: 'slug',
      group: 'page',
      description:
        'Optional. /projects/<slug>/ – generated from the repository name when the project is first featured, then kept even if the title or repository changes. Locked once the detail page is live.',
      options: { source: 'repo', slugify: (input: string) => slugifyProjectName(input) },
      readOnly: ({ document }) => document?.detailPageEnabled === true && Boolean((document?.slug as { current?: string } | undefined)?.current),
      validation: (r) =>
        r
          .custom(validateProjectSlug)
          .custom((value, context) =>
            validateUniqueSlug(value, context.document?._id, context.document?.repo, context.getClient({ apiVersion: '2025-02-19' }), detailPages),
          ),
    }),
    defineField({
      name: 'detailPageEnabled',
      title: 'Detail page live',
      type: 'boolean',
      group: 'page',
      description:
        'Switched on automatically when a featured project is published and never switched off, so the page stays online after the project stops being featured. "Hide on website" still removes it.',
      readOnly: ({ value }) => value === true,
    }),
    defineField({
      name: 'longDescription',
      title: 'About the project',
      type: 'blockContent',
      group: 'page',
      description: 'Optional. Extended description for the detail page. Without it the short description is shown.',
    }),
    defineField({
      name: 'features',
      title: 'Key features',
      type: 'array',
      group: 'page',
      description: 'Optional. Drag to reorder. The section is hidden when empty.',
      of: [
        defineArrayMember({
          type: 'object',
          name: 'feature',
          title: 'Feature',
          fields: [
            defineField({ name: 'title', title: 'Title', type: 'string', validation: (r) => r.required().max(80) }),
            defineField({
              name: 'description',
              title: 'Description',
              type: 'text',
              rows: 3,
              description: 'Two to four sentences.',
              validation: (r) => r.max(600),
            }),
            defineField({
              name: 'image',
              title: 'Image',
              type: 'image',
              description: 'Optional. Pick an existing image from the media library to avoid uploading it twice.',
              options: { hotspot: true },
              fields: [
                defineField({
                  name: 'alt',
                  title: 'Alternative text',
                  type: 'string',
                  validation: (r) => r.custom(validateAlt).custom((alt, context) => {
                    const parent = context.parent as { asset?: unknown } | undefined;
                    return parent?.asset && !alt ? 'Describe the image (alternative text is required).' : true;
                  }),
                }),
              ],
            }),
            defineField({
              name: 'icon',
              title: 'Icon',
              type: 'string',
              description: 'Optional. Shown when there is no image.',
              options: { list: featureIcons.map((i) => ({ title: i.title, value: i.value })) },
            }),
          ],
          preview: { select: { title: 'title', subtitle: 'description', media: 'image' } },
        }),
      ],
    }),
    defineField({
      name: 'videos',
      title: 'Videos',
      type: 'array',
      group: 'page',
      description: 'Optional YouTube videos. The first one is shown large. Players load only after a visitor clicks play.',
      of: [
        defineArrayMember({
          type: 'object',
          name: 'video',
          title: 'Video',
          fields: [
            defineField({
              name: 'url',
              title: 'YouTube URL',
              type: 'url',
              validation: (r) => r.required().uri({ scheme: ['https', 'http'] }).custom(validateYouTubeUrl),
            }),
            defineField({ name: 'title', title: 'Title', type: 'string', validation: (r) => r.max(120) }),
          ],
          preview: { select: { title: 'title', subtitle: 'url' } },
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
