import { blockContent } from './blockContent.ts';
import { codeBlock } from './codeBlock.ts';
import { post } from './post.ts';
import { project } from './project.ts';

/**
 * Registered document and object types.
 * future/game.ts is a prepared draft and intentionally NOT registered yet.
 */
export const schemaTypes = [post, project, blockContent, codeBlock];
