/**
 * Turns raw post documents (from Sanity or the local sample file) into safe, render-ready `Post` objects.
 *
 * Everything coming from the CMS is treated as untrusted input:
 * - only whitelisted block styles, decorators, marks and custom types survive,
 * - link targets are restricted to http(s), mailto, site-relative paths and #anchors,
 * - image URLs come from a resolver (Sanity CDN or local /images/ files), never straight from the document,
 * - no HTML is ever passed through – rich text is rendered by Astro components only.
 *
 * No Astro imports and only `.ts` relative imports, so `node --test` can load it directly.
 */
import { blogCategories, blogLanguages, defaultBlogLanguage, type BlogCategory } from '../../config/blog.ts';

export interface PostImage {
  src: string;
  srcset?: string;
  alt: string;
  width?: number;
  height?: number;
  caption?: string;
}

export interface LinkMarkDef {
  _key: string;
  _type: 'link';
  /** Sanitised target; `null` = rendered as plain text. */
  href: string | null;
  external: boolean;
}

export interface Span {
  _type: 'span';
  _key: string;
  text: string;
  marks: string[];
}

export interface TextBlock {
  _type: 'block';
  _key: string;
  style: BlockStyle;
  children: Span[];
  markDefs: LinkMarkDef[];
  listItem?: 'bullet' | 'number';
  level?: number;
}

export interface ImageNode {
  _type: 'image';
  _key: string;
  image: PostImage;
}

export interface CodeNode {
  _type: 'codeBlock';
  _key: string;
  code: string;
  language?: string;
}

export type BodyNode = TextBlock | ImageNode | CodeNode;

export type PostSource = 'manual' | 'github-release';

export interface Post {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  category: BlogCategory;
  publishedAt: string;
  language: string;
  source: PostSource;
  cover?: PostImage;
  body: BodyNode[];
  readingMinutes: number;
  relatedRepo?: { name: string; url: string };
  relatedRelease?: { tag: string; url: string };
  seo: { title: string; description: string; noindex: boolean };
}

/** Builds display URLs for an image object, or returns null if it cannot be shown. */
export type ImageResolver = (raw: RawImage, widths: readonly number[]) => Omit<PostImage, 'alt' | 'caption'> | null;

export interface RawImage {
  alt?: unknown;
  caption?: unknown;
  /** Local sample images only: path below /images/. */
  src?: unknown;
  asset?: { _id?: unknown; url?: unknown; metadata?: { dimensions?: { width?: unknown; height?: unknown } } } | null;
  crop?: { top?: number; bottom?: number; left?: number; right?: number } | null;
  hotspot?: { x?: number; y?: number; height?: number; width?: number } | null;
}

export type NormalizeResult = { ok: true; post: Post; warnings: string[] } | { ok: false; reason: string };

const OWNER = 'PeriBluGaming';
const SITE_HOST = 'periblugaming.github.io';

export const BLOCK_STYLES = ['normal', 'h2', 'h3', 'h4', 'blockquote'] as const;
export type BlockStyle = (typeof BLOCK_STYLES)[number];
export const DECORATORS = ['strong', 'em', 'code', 'underline', 'strike-through'] as const;

export const COVER_WIDTHS = [480, 800, 1200, 1600] as const;
export const BODY_WIDTHS = [480, 800, 1200] as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const CODE_LANGUAGE = /^[a-z0-9+#.-]{1,20}$/i;
const LOCAL_IMAGE = /^\/images\/[A-Za-z0-9/_.-]+\.(webp|avif|png|jpe?g)$/i;
const WORDS_PER_MINUTE = 220;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const optStr = (v: unknown): string | undefined => str(v) || undefined;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const isValidSlug = (slug: string): boolean => SLUG.test(slug) && slug.length <= 96;

/**
 * Returns a safe link target or null.
 * Allowed: https/http URLs, mailto:, site-relative paths ("/blog/x") and in-page anchors ("#x").
 */
export function safeHref(input: unknown): string | null {
  const href = str(input);
  if (!href || /[\u0000-\u001f\u007f\s]/.test(href)) return null;
  if (href.startsWith('#')) return href.length > 1 ? href : null;
  if (href.startsWith('/')) return href.startsWith('//') || href.startsWith('/\\') ? null : href;
  try {
    const url = new URL(href);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** External = absolute http(s) URL on another host. */
export function isExternalHref(href: string): boolean {
  if (!/^https?:/i.test(href)) return false;
  try {
    return new URL(href).hostname !== SITE_HOST;
  } catch {
    return true;
  }
}

/** Resolver for local sample images (files below public/images/). */
export const localImageResolver: ImageResolver = (raw) => {
  const src = str(raw.src);
  if (!LOCAL_IMAGE.test(src) || src.includes('..')) return null;
  const dims = raw.asset?.metadata?.dimensions;
  const width = Number(dims?.width) || undefined;
  const height = Number(dims?.height) || undefined;
  return { src, ...(width && { width }), ...(height && { height }) };
};

function toImage(raw: unknown, resolve: ImageResolver, widths: readonly number[]): PostImage | null {
  if (!isRecord(raw)) return null;
  const resolved = resolve(raw as RawImage, widths);
  if (!resolved) return null;
  const caption = optStr(raw.caption);
  return { ...resolved, alt: str(raw.alt), ...(caption && { caption }) };
}

function toBlock(raw: Record<string, unknown>, key: string): TextBlock | null {
  const markDefs: LinkMarkDef[] = [];
  for (const def of Array.isArray(raw.markDefs) ? raw.markDefs : []) {
    if (!isRecord(def) || !str(def._key)) continue;
    if (def._type === 'link') {
      const href = safeHref(def.href);
      markDefs.push({ _key: str(def._key), _type: 'link', href, external: href ? isExternalHref(href) : false });
    } else if (def._type === 'internalLink') {
      // Resolved by the GROQ query to the referenced post's slug.
      const slug = str(def.slug);
      const href = isValidSlug(slug) ? `/blog/${slug}/` : null;
      markDefs.push({ _key: str(def._key), _type: 'link', href, external: false });
    }
  }

  const allowedMarks = new Set<string>([...DECORATORS, ...markDefs.map((d) => d._key)]);
  const children: Span[] = [];
  (Array.isArray(raw.children) ? raw.children : []).forEach((child, i) => {
    if (!isRecord(child) || child._type !== 'span' || typeof child.text !== 'string') return;
    const marks = Array.isArray(child.marks) ? child.marks.filter((m): m is string => typeof m === 'string' && allowedMarks.has(m)) : [];
    children.push({ _type: 'span', _key: str(child._key) || `${key}-s${i}`, text: child.text, marks });
  });
  if (children.length === 0) return null;

  const style = (BLOCK_STYLES as readonly string[]).includes(str(raw.style)) ? (str(raw.style) as BlockStyle) : 'normal';
  const listItem = raw.listItem === 'bullet' || raw.listItem === 'number' ? raw.listItem : undefined;
  const level = listItem ? Math.min(Math.max(Math.trunc(Number(raw.level) || 1), 1), 4) : undefined;

  return { _type: 'block', _key: key, style, children, markDefs, ...(listItem && { listItem, level }) };
}

export function normalizeBody(raw: unknown, resolve: ImageResolver, warnings: string[] = []): BodyNode[] {
  const nodes: BodyNode[] = [];
  (Array.isArray(raw) ? raw : []).forEach((item, i) => {
    if (!isRecord(item)) return;
    const key = str(item._key) || `b${i}`;
    switch (item._type) {
      case 'block': {
        const block = toBlock(item, key);
        if (block) nodes.push(block);
        break;
      }
      case 'image': {
        const image = toImage(item, resolve, BODY_WIDTHS);
        if (image) nodes.push({ _type: 'image', _key: key, image });
        else warnings.push(`image block ${key} has no usable asset – skipped`);
        break;
      }
      case 'codeBlock': {
        const code = typeof item.code === 'string' ? item.code.replace(/\s+$/, '') : '';
        const language = CODE_LANGUAGE.test(str(item.language)) ? str(item.language).toLowerCase() : undefined;
        if (code) nodes.push({ _type: 'codeBlock', _key: key, code, ...(language && { language }) });
        break;
      }
      default:
        warnings.push(`unsupported content type "${String(item._type)}" – skipped`);
    }
  });
  return nodes;
}

export function bodyToPlainText(body: BodyNode[]): string {
  return body
    .map((n) => (n._type === 'block' ? n.children.map((c) => c.text).join('') : n._type === 'codeBlock' ? n.code : ''))
    .filter(Boolean)
    .join('\n\n');
}

export const readingMinutes = (text: string): number =>
  Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / WORDS_PER_MINUTE));

const truncate = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
};

const categoryById = new Map(blogCategories.map((c) => [c.id as string, c]));
const languageIds = new Set<string>(blogLanguages.map((l) => l.id));

export function normalizePost(raw: unknown, resolve: ImageResolver): NormalizeResult {
  if (!isRecord(raw)) return { ok: false, reason: 'not an object' };
  const id = str(raw._id) || '(unknown id)';
  const fail = (reason: string): NormalizeResult => ({ ok: false, reason: `post ${id}: ${reason}` });

  const title = str(raw.title);
  if (!title) return fail('missing title');

  const slug = str(isRecord(raw.slug) ? raw.slug.current : raw.slug);
  if (!isValidSlug(slug)) return fail(`invalid slug "${slug}" (lowercase letters, digits and hyphens only)`);

  const category = categoryById.get(str(raw.category));
  if (!category) return fail(`unknown category "${str(raw.category)}"`);

  const publishedAt = str(raw.publishedAt);
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) return fail('missing or invalid publishedAt');

  const warnings: string[] = [];
  const body = normalizeBody(raw.body, resolve, warnings);
  const plain = bodyToPlainText(body);
  const excerpt = str(raw.excerpt) || truncate(plain, 180);

  let cover: PostImage | undefined;
  if (raw.coverImage) {
    cover = toImage(raw.coverImage, resolve, COVER_WIDTHS) ?? undefined;
    if (!cover) warnings.push('cover image has no usable asset – skipped');
  }

  const repoName = str(raw.relatedRepo);
  const relatedRepo = REPO_NAME.test(repoName)
    ? { name: repoName, url: `https://github.com/${OWNER}/${repoName}` }
    : undefined;
  if (repoName && !relatedRepo) warnings.push(`invalid relatedRepo "${repoName}" – ignored`);

  let relatedRelease: Post['relatedRelease'];
  if (isRecord(raw.relatedRelease)) {
    const tag = str(raw.relatedRelease.tag).slice(0, 100);
    const url = safeHref(raw.relatedRelease.url);
    if (tag && url?.startsWith(`https://github.com/${OWNER}/`)) relatedRelease = { tag, url };
    else if (tag || url) warnings.push('relatedRelease needs a tag and a github.com/PeriBluGaming URL – ignored');
  }

  const seo = isRecord(raw.seo) ? raw.seo : {};
  const language = languageIds.has(str(raw.language)) ? str(raw.language) : defaultBlogLanguage;

  return {
    ok: true,
    warnings: warnings.map((w) => `post ${id}: ${w}`),
    post: {
      id,
      title,
      slug,
      excerpt,
      category,
      publishedAt: new Date(publishedAt).toISOString(),
      language,
      source: raw.source === 'github-release' ? 'github-release' : 'manual',
      ...(cover && { cover }),
      body,
      readingMinutes: readingMinutes(plain),
      ...(relatedRepo && { relatedRepo }),
      ...(relatedRelease && { relatedRelease }),
      seo: {
        title: truncate(str(seo.title) || title, 70),
        description: truncate(str(seo.description) || excerpt, 160),
        noindex: seo.noindex === true,
      },
    },
  };
}
