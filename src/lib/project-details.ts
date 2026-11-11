/**
 * Editorial content of project detail pages (Sanity `project` documents): long description, key features, gallery
 * and videos. Treated as untrusted input like blog posts – rich text goes through the blog's whitelist
 * (normalizeBody), images through a resolver (Sanity CDN only), videos are reduced to a validated YouTube ID.
 * Every field is optional; invalid entries are dropped individually with a warning, never failing the build.
 *
 * Pure: no Astro imports, only `.ts` relative imports, so `node --test` can load it directly.
 */
import { featureIcons, type FeatureIcon } from '../config/projects.ts';
import { normalizeBody, type BodyNode, type ImageResolver, type PostImage, type RawImage } from './blog/normalize.ts';
import { parseYouTubeId } from './youtube.ts';

export interface ProjectFeature {
  key: string;
  title: string;
  description?: string;
  image?: PostImage;
  icon?: FeatureIcon;
}

export interface GalleryImage {
  key: string;
  /** Responsive thumbnail (srcset) with intrinsic size. */
  thumb: PostImage;
  /** Large version for the lightbox. */
  full: string;
  caption?: string;
}

export interface ProjectVideo {
  key: string;
  /** Validated 11-character YouTube video ID. */
  id: string;
  title?: string;
}

export interface ProjectDetails {
  /** Responsive version of the card screenshot (first screenshot) for the hero; absent = use the card image. */
  hero?: PostImage;
  longDescription: BodyNode[];
  features: ProjectFeature[];
  gallery: GalleryImage[];
  videos: ProjectVideo[];
}

export const emptyDetails = (): ProjectDetails => ({ longDescription: [], features: [], gallery: [], videos: [] });

export const HERO_WIDTHS = [640, 960, 1280, 1920] as const;
export const FEATURE_IMAGE_WIDTHS = [480, 800, 1200] as const;
export const GALLERY_THUMB_WIDTHS = [400, 800, 1200] as const;
export const GALLERY_FULL_WIDTH = 1920;
export const MAX_FEATURES = 24;
export const MAX_GALLERY = 48;
export const MAX_VIDEOS = 12;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const iconValues = new Set<string>(featureIcons.map((i) => i.value));

function image(raw: unknown, resolve: ImageResolver, widths: readonly number[]): PostImage | null {
  if (!isRecord(raw)) return null;
  const alt = str(raw.alt);
  if (!alt) return null;
  const resolved = resolve(raw as RawImage, widths);
  return resolved ? { ...resolved, alt } : null;
}

/** Normalises the detail fields of one raw project document. `label` prefixes warnings. */
export function normalizeProjectDetails(raw: Record<string, unknown>, resolve: ImageResolver, label: string): { details: ProjectDetails; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (msg: string) => warnings.push(`${label}: ${msg}`);

  const bodyWarnings: string[] = [];
  const longDescription = normalizeBody(raw.longDescription, resolve, bodyWarnings);
  bodyWarnings.forEach((w) => warn(`long description: ${w}`));

  const features: ProjectFeature[] = [];
  list(raw.features).forEach((item, i) => {
    if (!isRecord(item)) return;
    const title = str(item.title).slice(0, 80);
    if (!title) return warn(`feature #${i + 1} has no title – skipped`);
    const description = str(item.description).slice(0, 600) || undefined;
    let img: PostImage | undefined;
    if (isRecord(item.image) && item.image.asset) {
      img = image(item.image, resolve, FEATURE_IMAGE_WIDTHS) ?? undefined;
      if (!img) warn(`feature "${title}": image without usable asset or alt text – skipped`);
    }
    const icon = iconValues.has(str(item.icon)) ? (str(item.icon) as FeatureIcon) : undefined;
    features.push({ key: str(item._key) || `f${i}`, title, ...(description && { description }), ...(img && { image: img }), ...(icon && { icon }) });
  });

  const gallery: GalleryImage[] = [];
  list(raw.screenshots).forEach((item, i) => {
    if (!isRecord(item)) return;
    const thumb = image(item, resolve, GALLERY_THUMB_WIDTHS);
    const full = thumb ? resolve(item as RawImage, [GALLERY_FULL_WIDTH])?.src : undefined;
    if (!thumb || !full) return warn(`screenshot #${i + 1} has no usable asset or alt text – left out of the gallery`);
    const caption = str(item.caption).slice(0, 200) || undefined;
    gallery.push({ key: str(item._key) || `g${i}`, thumb, full, ...(caption && { caption }) });
  });

  const videos: ProjectVideo[] = [];
  const seen = new Set<string>();
  list(raw.videos).forEach((item, i) => {
    if (!isRecord(item)) return;
    const id = parseYouTubeId(item.url);
    if (!id) return warn(`video #${i + 1} is not a valid YouTube URL – skipped`);
    if (seen.has(id)) return warn(`video #${i + 1} is listed twice – skipped`);
    seen.add(id);
    const title = str(item.title).slice(0, 120) || undefined;
    videos.push({ key: str(item._key) || `v${i}`, id, ...(title && { title }) });
  });

  const hero = image(raw.screenshot, resolve, HERO_WIDTHS) ?? undefined;

  return {
    details: {
      ...(hero && { hero }),
      longDescription,
      features: features.slice(0, MAX_FEATURES),
      gallery: gallery.slice(0, MAX_GALLERY),
      videos: videos.slice(0, MAX_VIDEOS),
    },
    warnings,
  };
}
