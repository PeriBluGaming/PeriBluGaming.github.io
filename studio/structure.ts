import type { StructureResolver } from 'sanity/structure';

/** Studio navigation. Separate from sanity.config.ts so it can be tested without a configured project. */
export const structure: StructureResolver = (S) =>
  S.list()
    .title('Content')
    .items([
      S.listItem()
        .title('Blog posts')
        .schemaType('post')
        .child(S.documentTypeList('post').title('Blog posts').defaultOrdering([{ field: 'publishedAt', direction: 'desc' }])),
      S.listItem()
        .title('Projects')
        .schemaType('project')
        .child(
          S.documentTypeList('project')
            .title('Projects')
            .defaultOrdering([
              { field: 'featured', direction: 'desc' },
              { field: 'featuredOrder', direction: 'asc' },
              { field: 'repo', direction: 'asc' },
            ]),
        ),
    ]);
