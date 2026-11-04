import { defineField, defineType } from 'sanity';

/**
 * PREPARED, NOT REGISTERED. Personal game collection ("Game Collection" section).
 * New additions = sorted by `purchasedAt`; a "Gaming" blog post can reference a game later.
 * To activate: add `game` to schemaTypes/index.ts and add a page + loader on the website.
 *
 * SECURITY: in a public dataset every field of a PUBLISHED document is readable by anyone via the API, even if the
 * website doesn't show it. Don't store private data (prices, personal notes) here unless the dataset is private.
 */
export const game = defineType({
  name: 'game',
  title: 'Game',
  type: 'document',
  fields: [
    defineField({ name: 'title', title: 'Title', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'platform',
      title: 'Platform',
      type: 'string',
      options: { list: ['PS1', 'PS2', 'PS3', 'PS4', 'PS5', 'SNES', 'N64', 'GameCube', 'Wii', 'Switch', 'Game Boy', 'PC', 'Other'] },
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'cover',
      title: 'Cover',
      type: 'image',
      fields: [{ name: 'alt', type: 'string', title: 'Alternative text' }],
    }),
    defineField({ name: 'purchasedAt', title: 'Purchase date', type: 'date' }),
    defineField({
      name: 'status',
      title: 'Status',
      type: 'string',
      options: { list: ['backlog', 'playing', 'completed', '100%', 'dropped', 'collection only'] },
      initialValue: 'backlog',
    }),
    defineField({ name: 'notes', title: 'Notes', type: 'text', rows: 4 }),
  ],
  orderings: [{ title: 'Newest additions', name: 'purchasedAtDesc', by: [{ field: 'purchasedAt', direction: 'desc' }] }],
});
