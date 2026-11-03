/**
 * Sanity data access. Runs at build time only (Astro frontmatter) – never in the browser.
 *
 * Reads published documents only. Drafts ("drafts.*"), unpublished release versions ("versions.*") and any other
 * non-root path are excluded twice: by the "published" perspective and by an explicit filter in the query.
 * This matters when a read token is used (private dataset): a token CAN read drafts, the query never asks for them.
 */
import { createClient, type ClientConfig } from '@sanity/client';
import { createImageUrlBuilder } from '@sanity/image-url';
import type { BlogConfig } from './config.ts';
import type { ImageResolver } from './normalize.ts';

type SanityConfig = Extract<BlogConfig, { mode: 'sanity' }>;

const imageProjection = `{ alt, caption, crop, hotspot, asset->{ _id, url, metadata { dimensions { width, height } } } }`;

/** All published, non-hidden posts whose publish date has passed. Newest first. */
export const POSTS_QUERY = /* groq */ `
*[_type == "post" && _id in path("*") && defined(slug.current) && hidden != true && publishedAt <= now()]
| order(publishedAt desc) {
  _id,
  title,
  slug,
  excerpt,
  category,
  publishedAt,
  language,
  source,
  coverImage ${imageProjection},
  body[] {
    ...,
    _type == "image" => ${imageProjection},
    _type == "block" => {
      markDefs[] { ..., _type == "internalLink" => { "slug": reference->slug.current } }
    }
  },
  relatedRepo,
  relatedRelease { tag, url },
  seo { title, description, noindex }
}`;

/** Read-only client settings. Exported for tests. */
export function sanityClientConfig(config: SanityConfig): ClientConfig {
  return {
    projectId: config.projectId,
    dataset: config.dataset,
    apiVersion: config.apiVersion,
    // Builds want fresh data right after publishing, not the edge cache.
    useCdn: false,
    // Never drafts or release versions, regardless of the token's permissions.
    perspective: 'published',
    // No visual-editing metadata in the output.
    stega: false,
    resultSourceMap: false,
    // Server-side only; never send cookies.
    withCredentials: false,
    timeout: 15_000,
    maxRetries: 3,
    ...(config.token && { token: config.token }),
  };
}

export async function fetchSanityPosts(config: SanityConfig): Promise<unknown> {
  return createClient(sanityClientConfig(config)).fetch(POSTS_QUERY);
}

const SANITY_CDN = 'https://cdn.sanity.io/';

export function sanityImageResolver(config: SanityConfig): ImageResolver {
  const builder = createImageUrlBuilder({ projectId: config.projectId, dataset: config.dataset });

  return (raw, widths) => {
    const id = raw.asset?._id;
    if (typeof id !== 'string' || !id.startsWith('image-')) return null;

    const source = { asset: { _ref: id }, ...(raw.crop && { crop: raw.crop }), ...(raw.hotspot && { hotspot: raw.hotspot }) };
    const urlFor = (w: number) => builder.image(source).width(w).fit('max').auto('format').quality(80).url();

    const src = urlFor(widths[Math.min(1, widths.length - 1)]);
    if (!src.startsWith(SANITY_CDN)) return null;

    // Intrinsic size after cropping, used for width/height attributes (prevents layout shift).
    const dims = raw.asset?.metadata?.dimensions;
    const crop = raw.crop ?? {};
    const width = Number(dims?.width) * (1 - (crop.left ?? 0) - (crop.right ?? 0)) || undefined;
    const height = Number(dims?.height) * (1 - (crop.top ?? 0) - (crop.bottom ?? 0)) || undefined;

    return {
      src,
      srcset: widths.map((w) => `${urlFor(w)} ${w}w`).join(', '),
      ...(width && { width: Math.round(width) }),
      ...(height && { height: Math.round(height) }),
    };
  };
}
