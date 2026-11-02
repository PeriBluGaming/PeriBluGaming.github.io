// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// User site on GitHub Pages: served from the domain root, so no `base` is needed.
export default defineConfig({
  site: 'https://periblugaming.github.io',
  vite: {
    plugins: [tailwindcss()],
  },
});
