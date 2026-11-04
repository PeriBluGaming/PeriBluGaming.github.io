/**
 * Blog / devlog configuration shared by the website and the Sanity Studio (studio/).
 * Kept free of imports so both `node --test` and the Studio bundler can load it directly.
 */

export type BlogAccent = 'cyan' | 'pink' | 'violet';
export type BlogCategoryId = 'devlog' | 'news' | 'gaming' | 'releases';

export interface BlogCategory {
  id: BlogCategoryId;
  label: string;
  /** Shown on the category page and as help text in the Studio. */
  description: string;
  accent: BlogAccent;
}

/** Order = order of the filter links. Adding a category here makes it available in the Studio, too. */
export const blogCategories: BlogCategory[] = [
  {
    id: 'devlog',
    label: 'Devlog',
    description: 'Development reports: recompilation projects, widescreen, modern camera and technical challenges.',
    accent: 'cyan',
  },
  { id: 'news', label: 'News', description: 'General news and project announcements.', accent: 'pink' },
  {
    id: 'gaming',
    label: 'Gaming',
    description: 'Gaming topics, retro gaming, personal impressions and new additions.',
    accent: 'violet',
  },
  { id: 'releases', label: 'Releases', description: 'New project versions and release notes.', accent: 'cyan' },
];

/** Article languages. Only English is used for now; the field exists so translations can be added later. */
export const blogLanguages = [{ id: 'en', label: 'English' }] as const;
export const defaultBlogLanguage = 'en';

export const blog = {
  title: 'Blog',
  description:
    'Devlogs, news, releases and gaming thoughts from PeriBluGaming – recompilation, widescreen hacks, homebrew and retro gaming.',
  /** URL prefix of all blog routes. */
  basePath: '/blog',
} as const;
