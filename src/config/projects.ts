/**
 * Central project configuration.
 *
 * Repositories are loaded automatically from the GitHub API at build time.
 * Everything GitHub cannot know (category, short copy, tags, featured order,
 * exclusions) lives here. Repository names are matched case-insensitively.
 */

export type Accent = 'cyan' | 'pink' | 'violet';
export type CategoryId = 'playstation' | 'nintendo' | 'homebrew' | 'tools' | 'other';
export type ArtKind = 'disc' | 'cartridge' | 'handheld' | 'code';

export interface Category {
  id: CategoryId;
  /** Label used for filter buttons. */
  label: string;
  accent: Accent;
  /** Stylised artwork shown when a project has no image. */
  art: ArtKind;
}

/** Order defines the order of the filter buttons. */
export const categories: Category[] = [
  { id: 'playstation', label: 'PlayStation', accent: 'cyan', art: 'disc' },
  { id: 'nintendo', label: 'Nintendo / SNES', accent: 'violet', art: 'cartridge' },
  { id: 'homebrew', label: 'Homebrew', accent: 'pink', art: 'handheld' },
  { id: 'tools', label: 'Tools', accent: 'cyan', art: 'code' },
  { id: 'other', label: 'Other', accent: 'violet', art: 'code' },
];

/** Repositories without an override end up here. */
export const defaultCategory: CategoryId = 'other';

/** Screenshot for a featured project card. See docs/project-screenshots.md. */
export interface ProjectImage {
  /** File below public/images/projects/, e.g. "/images/projects/<project>/<file>.webp". Checked at build time. */
  src: string;
  /** Describes what the screenshot shows. */
  alt: string;
  /** CSS object-position for the 16:9 crop, e.g. "center", "top", "50% 30%". Default: "center". */
  position?: string;
}

export interface ProjectOverride {
  title?: string;
  /** Short card copy. Falls back to the GitHub description. */
  description?: string;
  category?: CategoryId;
  /** Max. two tags are shown on cards (e.g. platform + type). */
  tags?: string[];
  /** Exclude this repository from the site entirely. */
  hidden?: boolean;
}

export const projectOverrides: Record<string, ProjectOverride> = {
  ToyStory2Recomp: {
    title: 'Toy Story 2 Recomp',
    description: 'Native recompilation with modern camera, widescreen and more.',
    category: 'playstation',
    tags: ['PS1', 'Recomp'],
  },
  BugsBunnyLostinTimeRecomp: {
    title: 'Bugs Bunny Recomp',
    description: 'Bugs Bunny: Lost in Time, statically recompiled to a native PC executable.',
    category: 'playstation',
    tags: ['PS1', 'Recomp'],
  },
  SuperMarioWorld2YoshisIslandRecomp: {
    title: "Yoshi's Island Recomp",
    description: 'Native C recompilation of the SNES classic into a standalone PC executable.',
    category: 'nintendo',
    tags: ['SNES', 'Recomp'],
  },
  RescueShotRecomp: {
    title: 'RescueShot Recompiled',
    description:
      'The PlayStation light-gun shooter on modern PCs, with optional native PlayStation Mouse support.',
    category: 'playstation',
    tags: ['PS1', 'Recomp'],
  },
  romm2switch: {
    title: 'RomM2Switch',
    description: 'Browse your self-hosted RomM library and download ROMs straight to your Switch SD card.',
    category: 'homebrew',
    tags: ['Switch', 'Homebrew'],
  },
  psxrecomp: {
    title: 'PSXRecomp',
    description: 'General-purpose static recompiler for the PlayStation 1.',
    category: 'tools',
    tags: ['Tools', 'PS1'],
  },
  'recomp-ui': {
    title: 'recomp-ui',
    description: 'Shared launcher and in-game UI for static recompilation projects.',
    category: 'tools',
    tags: ['Tools', 'UI'],
  },
};

export interface FeaturedEntry {
  repo: string;
  accent: Accent;
  /** Optional screenshot. Without it the card shows the stylised platform art. */
  image?: ProjectImage;
}

/** Featured projects in display order – independent of GitHub sorting. */
export const featuredProjects: FeaturedEntry[] = [
  { repo: 'ToyStory2Recomp', accent: 'cyan', image: { src: '/images/projects/toystory2/gameplay.png', alt: "Buzz Lightyear exploring Andy's room in ToyStory2Recomp.", position: 'center' } },
  { repo: 'BugsBunnyLostinTimeRecomp', accent: 'pink' },
  { repo: 'SuperMarioWorld2YoshisIslandRecomp', accent: 'violet' },
  { repo: 'romm2switch', accent: 'cyan' },
];

export const listSettings = {
  /** Hide forked repositories in "All Projects" (featured projects are always kept). */
  hideForks: false,
  /** Hide archived repositories in "All Projects" (featured projects are always kept). */
  hideArchived: true,
  /** Repository names that never appear anywhere. */
  exclude: ['PeriBluGaming.github.io', 'PeriBluGaming'] as string[],
};
