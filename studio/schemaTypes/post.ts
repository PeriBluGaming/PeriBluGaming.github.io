import { defineField, defineType } from 'sanity';
import { blogCategories, blogLanguages, defaultBlogLanguage } from '../../src/config/blog.ts';

const OWNER = 'PeriBluGaming';

/**
 * Blog / devlog post. Drafts are never published to the website: only documents that were
 * published in the Studio (and whose publish date has passed) are fetched at build time.
 */
export const post = defineType({
  name: 'post',
  title: 'Blog post',
  type: 'document',
  groups: [
    { name: 'content', title: 'Content', default: true },
    { name: 'meta', title: 'Links & source' },
    { name: 'seo', title: 'SEO' },
  ],
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      group: 'content',
      validation: (r) => r.required().max(120),
    }),
    defineField({
      name: 'slug',
      title: 'URL slug',
      type: 'slug',
      group: 'content',
      description: 'Part of the URL: /blog/<slug>/. Avoid changing it after publishing.',
      options: {
        source: 'title',
        maxLength: 96,
        slugify: (input: string) =>
          input
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 96),
      },
      validation: (r) =>
        r.required().custom((slug) =>
          !slug?.current || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.current)
            ? true
            : 'Lowercase letters, digits and single hyphens only.',
        ),
    }),
    defineField({
      name: 'excerpt',
      title: 'Short description',
      type: 'text',
      rows: 3,
      group: 'content',
      description: 'Shown on the overview cards and below the title.',
      validation: (r) => r.required().max(220),
    }),
    defineField({
      name: 'category',
      title: 'Category',
      type: 'string',
      group: 'content',
      options: {
        list: blogCategories.map((c) => ({ title: c.label, value: c.id })),
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'devlog',
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'publishedAt',
      title: 'Publish date',
      type: 'datetime',
      group: 'content',
      description: 'Posts with a future date stay hidden until a build runs after that date.',
      initialValue: () => new Date().toISOString(),
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'coverImage',
      title: 'Cover image',
      type: 'image',
      group: 'content',
      description: 'Recommended: 16:9, at least 1600 × 900 px.',
      options: { hotspot: true },
      fields: [
        defineField({
          name: 'alt',
          title: 'Alternative text',
          type: 'string',
          validation: (r) => r.required(),
        }),
      ],
    }),
    defineField({ name: 'body', title: 'Article', type: 'blockContent', group: 'content' }),
    defineField({
      name: 'language',
      title: 'Language',
      type: 'string',
      group: 'meta',
      description: 'Prepared for translations later. Only English is used for now.',
      options: { list: blogLanguages.map((l) => ({ title: l.label, value: l.id })) },
      initialValue: defaultBlogLanguage,
      hidden: blogLanguages.length < 2,
    }),
    defineField({
      name: 'hidden',
      title: 'Hide on website',
      type: 'boolean',
      group: 'meta',
      description: 'Keeps a published post off the website without deleting or unpublishing it.',
      initialValue: false,
    }),
    defineField({
      name: 'relatedRepo',
      title: 'GitHub repository',
      type: 'string',
      group: 'meta',
      description: `Optional. Repository name below github.com/${OWNER}/, e.g. ToyStory2Recomp.`,
      validation: (r) => r.regex(/^[A-Za-z0-9._-]{1,100}$/, { name: 'repository name' }),
    }),
    defineField({
      name: 'relatedRelease',
      title: 'GitHub release',
      type: 'object',
      group: 'meta',
      description: 'Optional. Links the post to a release.',
      options: { collapsible: true, collapsed: true },
      fields: [
        defineField({ name: 'tag', title: 'Version / tag', type: 'string', validation: (r) => r.max(100) }),
        defineField({
          name: 'url',
          title: 'Release URL',
          type: 'url',
          validation: (r) =>
            r.uri({ scheme: ['https'] }).custom((url) =>
              !url || url.startsWith(`https://github.com/${OWNER}/`) ? true : `Must start with https://github.com/${OWNER}/`,
            ),
        }),
      ],
    }),
    defineField({
      name: 'source',
      title: 'Source',
      type: 'string',
      group: 'meta',
      description: 'Written by hand, or created from a GitHub release (future automation).',
      options: {
        list: [
          { title: 'Written manually', value: 'manual' },
          { title: 'GitHub release (automatic)', value: 'github-release' },
        ],
      },
      initialValue: 'manual',
      readOnly: true,
    }),
    defineField({
      name: 'seo',
      title: 'SEO',
      type: 'object',
      group: 'seo',
      description: 'Optional. Falls back to the title and short description.',
      fields: [
        defineField({ name: 'title', title: 'SEO title', type: 'string', validation: (r) => r.max(70) }),
        defineField({
          name: 'description',
          title: 'Meta description',
          type: 'text',
          rows: 3,
          validation: (r) => r.max(160),
        }),
        defineField({
          name: 'noindex',
          title: 'Hide from search engines',
          type: 'boolean',
          initialValue: false,
        }),
      ],
    }),
  ],
  orderings: [
    { title: 'Publish date, newest', name: 'publishedAtDesc', by: [{ field: 'publishedAt', direction: 'desc' }] },
  ],
  preview: {
    select: { title: 'title', category: 'category', date: 'publishedAt', media: 'coverImage' },
    prepare: ({ title, category, date, media }) => ({
      title,
      subtitle: [blogCategories.find((c) => c.id === category)?.label, date?.slice(0, 10)].filter(Boolean).join(' · '),
      media,
    }),
  },
});
