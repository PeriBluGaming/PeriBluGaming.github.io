import { defineField, defineType } from 'sanity';

/**
 * PREPARED, NOT REGISTERED. Future replacement for the hand-written overrides in src/config/projects.ts.
 *
 * Plan: the website keeps loading repositories from the GitHub API; documents of this type add title,
 * copy, screenshots, featured state, visibility, accent and order on top (matched by `repo`).
 * The existing config file stays the fallback while the CMS is not configured.
 * To activate: add `project` to schemaTypes/index.ts and extend src/lib/projects.ts.
 */
export const project = defineType({
  name: 'project',
  title: 'Project',
  type: 'document',
  fields: [
    defineField({
      name: 'repo',
      title: 'GitHub repository',
      type: 'string',
      description: 'Repository name below github.com/PeriBluGaming/.',
      validation: (r) => r.required().regex(/^[A-Za-z0-9._-]{1,100}$/),
    }),
    defineField({ name: 'title', title: 'Title', type: 'string' }),
    defineField({ name: 'description', title: 'Description', type: 'text', rows: 3 }),
    defineField({
      name: 'screenshots',
      title: 'Screenshots',
      type: 'array',
      of: [{ type: 'image', options: { hotspot: true }, fields: [{ name: 'alt', type: 'string', title: 'Alternative text' }] }],
    }),
    defineField({ name: 'featured', title: 'Featured', type: 'boolean', initialValue: false }),
    defineField({ name: 'visible', title: 'Visible on website', type: 'boolean', initialValue: true }),
    defineField({
      name: 'accent',
      title: 'Accent colour',
      type: 'string',
      options: { list: ['cyan', 'pink', 'violet'], layout: 'radio', direction: 'horizontal' },
      initialValue: 'cyan',
    }),
    defineField({ name: 'order', title: 'Sort order', type: 'number', description: 'Lower = first.' }),
  ],
});
