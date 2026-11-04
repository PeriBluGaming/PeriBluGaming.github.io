import { defineArrayMember, defineField, defineType } from 'sanity';

/**
 * Rich text for articles. Must stay in sync with the whitelist in src/lib/blog/normalize.ts
 * (styles, decorators, link types, image, codeBlock) – anything else is dropped by the website.
 */
export const blockContent = defineType({
  name: 'blockContent',
  title: 'Content',
  type: 'array',
  of: [
    defineArrayMember({
      type: 'block',
      styles: [
        { title: 'Normal', value: 'normal' },
        { title: 'Heading 2', value: 'h2' },
        { title: 'Heading 3', value: 'h3' },
        { title: 'Heading 4', value: 'h4' },
        { title: 'Quote', value: 'blockquote' },
      ],
      lists: [
        { title: 'Bullet', value: 'bullet' },
        { title: 'Numbered', value: 'number' },
      ],
      marks: {
        decorators: [
          { title: 'Bold', value: 'strong' },
          { title: 'Italic', value: 'em' },
          { title: 'Code', value: 'code' },
          { title: 'Underline', value: 'underline' },
          { title: 'Strike', value: 'strike-through' },
        ],
        annotations: [
          defineArrayMember({
            name: 'link',
            title: 'Link',
            type: 'object',
            fields: [
              defineField({
                name: 'href',
                title: 'URL',
                type: 'url',
                description: 'https://… for external links, /path for pages on this site, mailto: for e-mail.',
                validation: (r) =>
                  r.required().uri({ scheme: ['http', 'https', 'mailto'], allowRelative: true }),
              }),
            ],
          }),
          defineArrayMember({
            name: 'internalLink',
            title: 'Link to post',
            type: 'object',
            fields: [
              defineField({
                name: 'reference',
                title: 'Post',
                type: 'reference',
                to: [{ type: 'post' }],
                validation: (r) => r.required(),
              }),
            ],
          }),
        ],
      },
    }),
    defineArrayMember({
      type: 'image',
      options: { hotspot: true },
      fields: [
        defineField({
          name: 'alt',
          title: 'Alternative text',
          type: 'string',
          description: 'What the image shows, for screen readers.',
          validation: (r) => r.required(),
        }),
        defineField({ name: 'caption', title: 'Caption', type: 'string' }),
      ],
    }),
    defineArrayMember({ type: 'codeBlock' }),
  ],
});
