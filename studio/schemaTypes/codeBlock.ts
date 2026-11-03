import { defineField, defineType } from 'sanity';

/** Minimal code block without an extra plugin. Rendered as plain, escaped text on the website. */
export const codeBlock = defineType({
  name: 'codeBlock',
  title: 'Code',
  type: 'object',
  fields: [
    defineField({
      name: 'language',
      title: 'Language',
      type: 'string',
      options: {
        list: ['c', 'cpp', 'asm', 'python', 'ts', 'js', 'json', 'bash', 'yaml', 'text'],
      },
      initialValue: 'c',
    }),
    defineField({ name: 'code', title: 'Code', type: 'text', rows: 10, validation: (r) => r.required() }),
  ],
  preview: {
    select: { language: 'language', code: 'code' },
    prepare: ({ language, code }) => ({ title: (code as string | undefined)?.split('\n')[0] ?? 'Code', subtitle: language }),
  },
});
