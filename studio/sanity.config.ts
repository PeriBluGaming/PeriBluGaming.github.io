import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';
import { documentActions } from './actions/detailPagePublish';
import { dataset, projectId } from './env';
import { schemaTypes } from './schemaTypes';
import { structure } from './structure';

export default defineConfig({
  name: 'default',
  title: 'PeriBluGaming',
  projectId,
  dataset,
  plugins: [structureTool({ structure })],
  schema: { types: schemaTypes },
  document: { actions: documentActions },
});
