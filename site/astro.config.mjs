import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  outDir: '../docs',
  base: '/ailt-hku-food',
  compressHTML: false,
  build: { assets: 'assets' },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    // docs already contains the app's self-hosting guide and screenshots.
    build: { emptyOutDir: false, cssMinify: false },
  },
});
