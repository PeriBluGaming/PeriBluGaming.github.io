export type SocialId = 'github' | 'youtube' | 'x';

export interface SocialLink {
  id: SocialId;
  label: string;
  /** Leave empty to hide the link everywhere on the site. */
  url: string;
}

export const site = {
  name: 'PeriBluGaming',
  url: 'https://periblugaming.github.io',
  title: 'PeriBluGaming – Retro Games. Modern Possibilities.',
  description:
    'Preserving classic gaming experiences through modern technology, native recompilation and creative development. Open-source PlayStation and SNES recompilation projects, homebrew and tools.',
  tagline: '(Retro) Gaming · Game Dev · Development',
  githubUser: 'PeriBluGaming',
  githubUrl: 'https://github.com/PeriBluGaming',
  socials: [
    { id: 'github', label: 'GitHub', url: 'https://github.com/PeriBluGaming' },
    { id: 'youtube', label: 'YouTube', url: '' },
    { id: 'x', label: 'X', url: '' },
  ] satisfies SocialLink[],
} as const;

export const navLinks = [
  { label: 'Home', href: '/' },
  { label: 'Projects', href: '/#projects' },
  { label: 'About', href: '/#about' },
] as const;

export const activeSocials = (): SocialLink[] => site.socials.filter((s) => s.url.trim() !== '');
