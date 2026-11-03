import { blockContent } from './blockContent';
import { codeBlock } from './codeBlock';
import { post } from './post';

/**
 * Registered document and object types.
 * future/project.ts and future/game.ts are prepared drafts and intentionally NOT registered yet.
 */
export const schemaTypes = [post, blockContent, codeBlock];
