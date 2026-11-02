export type SocialId = 'github' | 'youtube' | 'x' | 'instagram' | 'reddit' | 'threads';

export interface SocialLink {
  id: SocialId;
  label: string;
  url: string;
  /** Set to false to hide the profile everywhere on the site. */
  enabled: boolean;
}

const GITHUB_URL = 'https://github.com/PeriBluGaming';

/** Single source for all social profiles; order = display order in header, menu and footer. */
export const socials: SocialLink[] = [
  { id: 'github', label: 'GitHub', url: GITHUB_URL, enabled: true },
  { id: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/@PeriBluGaming', enabled: true },
  { id: 'x', label: 'X', url: 'https://x.com/PeriBluGaming', enabled: true },
  { id: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/periblugaming/', enabled: true },
  { id: 'reddit', label: 'Reddit', url: 'https://www.reddit.com/user/PeriBluGaming/', enabled: true },
  { id: 'threads', label: 'Threads', url: 'https://www.threads.com/@PeriBluGaming', enabled: true },
];

export const site = {
  name: 'PeriBluGaming',
  url: 'https://periblugaming.github.io',
  title: 'PeriBluGaming – Retro Games. Modern Possibilities.',
  description:
    'Preserving classic gaming experiences through modern technology, native recompilation and creative development. Open-source PlayStation and SNES recompilation projects, homebrew and tools.',
  tagline: '(Retro) Gaming · Game Dev · Development',
  githubUser: 'PeriBluGaming',
  githubUrl: GITHUB_URL,
} as const;

export const navLinks = [
  { label: 'Home', href: '/' },
  { label: 'Projects', href: '/#projects' },
  { label: 'About', href: '/#about' },
] as const;

export const activeSocials = (): SocialLink[] => socials.filter((s) => s.enabled && s.url.trim() !== '');
