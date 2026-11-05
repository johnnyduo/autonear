import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Preload the four critical latin font files (the italic serif face is used by every headline's <em>) so the headline never swaps late (LCP) or reflows the page (CLS).
const preloadFonts = () => ({
  name: 'preload-critical-fonts',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      if (!ctx.bundle) return html;
      const want = /(instrument-serif-latin-400-(?:normal|italic)|inter-tight-latin-wght-normal|jetbrains-mono-latin-wght-normal)-[\w-]+\.woff2$/;
      const tags = Object.keys(ctx.bundle).filter((f) => want.test(f)).map((f) => ({ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${f}`, crossorigin: '' }, injectTo: 'head' }));
      return { html, tags };
    },
  },
});

export default defineConfig({
  plugins: [react(), preloadFonts()],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { target: 'es2022', chunkSizeWarningLimit: 700 },
});
