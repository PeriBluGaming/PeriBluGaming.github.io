/**
 * Sanity `project` documents (studio/schemaTypes/project.ts) – editorial overrides for GitHub repositories.
 * Build time only. Reuses the blog's Sanity configuration and client settings: published perspective only,
 * no CDN cache, no cookies, optional server-side read token. Nothing here reaches the browser.
 */
import { createClient } from '@sanity/client';
import type { ProjectImage } from '../config/projects.ts';
import type { BlogConfig } from './blog/config.ts';
import type { RawImage } from './blog/normalize.ts';
import { sanityClientConfig, sanityImageResolver } from './blog/sanity.ts';
import { PROJECT_DOCUMENT_FILTER } from './project-visibility.ts';

type SanityConfig = Extract<BlogConfig, { mode: 'sanity' }>;

/**
 * All published project documents (root IDs only: no drafts.*, no versions.*), in a stable order, with an explicit
 * projection. Only the first screenshot is needed for the featured card. `_rev` feeds the deploy fingerprint.
 */
export const PROJECTS_QUERY = /* groq */ `
*[${PROJECT_DOCUMENT_FILTER}] | order(_id asc) {
  _id,
  _rev,
  _updatedAt,
  repo,
  title,
  description,
  category,
  tags,
  hidden,
  featured,
  featuredOrder,
  accent,
  "screenshot": screenshots[0]{ alt, crop, hotspot, asset->{ _id, url, metadata { dimensions { width, height } } } }
}`;

export async function fetchSanityProjects(config: SanityConfig): Promise<unknown> {
  return createClient(sanityClientConfig(config)).fetch(PROJECTS_QUERY);
}

/** Card art area is at most ~272 CSS px wide; 800 px covers high-density screens. */
const SCREENSHOT_WIDTH = 800;

const fraction = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const percent = (v: number) => `${Math.round(v * 1000) / 10}%`;

/**
 * Focal point for CSS object-position. Sanity's hotspot is relative to the full image; the delivered image is
 * already cropped, so the hotspot is mapped into the cropped area. No hotspot → centre.
 */
export function hotspotPosition(hotspot: RawImage['hotspot'], crop: RawImage['crop']): string {
  if (!hotspot || !Number.isFinite(hotspot.x) || !Number.isFinite(hotspot.y)) return 'center';
  const left = fraction(crop?.left, 0);
  const right = fraction(crop?.right, 0);
  const top = fraction(crop?.top, 0);
  const bottom = fraction(crop?.bottom, 0);
  const w = 1 - left - right;
  const h = 1 - top - bottom;
  if (w <= 0 || h <= 0) return 'center';
  return `${percent(fraction((hotspot.x! - left) / w, 0.5))} ${percent(fraction((hotspot.y! - top) / h, 0.5))}`;
}

/** Turns the first Sanity screenshot into the website's ProjectImage, or null if unusable (→ local fallback). */
export function sanityScreenshotResolver(config: SanityConfig): (shot: unknown) => ProjectImage | null {
  const resolve = sanityImageResolver(config);
  return (shot) => {
    if (typeof shot !== 'object' || shot === null) return null;
    const raw = shot as RawImage;
    const alt = typeof raw.alt === 'string' ? raw.alt.trim() : '';
    if (!alt) return null;
    // Validates the asset ID and only ever returns cdn.sanity.io URLs (see sanityImageResolver).
    const image = resolve(raw, [SCREENSHOT_WIDTH]);
    if (!image) return null;
    return { src: image.src, alt, position: hotspotPosition(raw.hotspot, raw.crop) };
  };
}
