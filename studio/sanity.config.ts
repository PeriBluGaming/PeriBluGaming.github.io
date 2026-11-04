import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';
import { dataset, projectId } from './env';
import { schemaTypes } from './schemaTypes';

export default defineConfig({
  name: 'default',
  title: 'PeriBluGaming',
  projectId,
  dataset,
  plugins: [
    structureTool({
      structure: (S) =>
        S.list()
          .title('Content')
          .items([
            S.listItem()
              .title('Blog posts')
              .schemaType('post')
              .child(S.documentTypeList('post').title('Blog posts').defaultOrdering([{ field: 'publishedAt', direction: 'desc' }])),
          ]),
    }),
  ],
  schema: { types: schemaTypes },
});
