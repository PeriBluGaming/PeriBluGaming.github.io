/**
 * Build-time validation of featured project screenshots.
 * A misconfigured image fails the build instead of shipping a broken <img>.
 * Kept free of Astro/extensionless imports so `node --test` can load it directly.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectImage } from '../config/projects';

export const PROJECT_IMAGE_DIR = '/images/projects/';

const ALLOWED_EXTENSIONS = /\.(webp|avif|png|jpe?g)$/i;
/** Keywords, percentages and lengths only – the value ends up in a style attribute. */
const SAFE_POSITION = /^[a-z0-9.%\s-]+$/i;

export class ProjectImageError extends Error {
  constructor(repo: string, problem: string) {
    super(`[projects] Invalid screenshot for "${repo}": ${problem}`);
    this.name = 'ProjectImageError';
  }
}

export function validateProjectImage(image: ProjectImage, repo: string, publicDir: string): ProjectImage {
  const src = image.src.trim();
  const alt = image.alt.trim();
  const position = image.position?.trim() || 'center';

  if (!src.startsWith(PROJECT_IMAGE_DIR) || src.includes('..') || /[?#]/.test(src)) {
    throw new ProjectImageError(repo, `src must be a local file below ${PROJECT_IMAGE_DIR} (got "${image.src}").`);
  }
  if (!ALLOWED_EXTENSIONS.test(src)) {
    throw new ProjectImageError(repo, `unsupported file type "${src}" (use .webp, .avif, .png or .jpg).`);
  }
  const file = join(publicDir, src);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new ProjectImageError(repo, `file not found: public${src}`);
  }
  if (!alt) {
    throw new ProjectImageError(repo, 'alt text must not be empty.');
  }
  if (!SAFE_POSITION.test(position)) {
    throw new ProjectImageError(repo, `position "${image.position}" is not a valid object-position value.`);
  }

  return { src, alt, position };
}
