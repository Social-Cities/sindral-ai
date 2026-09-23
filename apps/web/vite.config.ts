import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // pnpm runs Vite from apps/web, while the documented shared environment file
  // lives at the repository root.
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router/')) return 'react-vendor';
          if (id.includes('/@supabase/')) return 'supabase-vendor';
          if (id.includes('/@tanstack/')) return 'query-vendor';
          if (id.includes('/react-markdown/') || id.includes('/remark-') || id.includes('/unified/') || id.includes('/micromark')) return 'markdown-vendor';
          if (id.includes('/zod/')) return 'schema-vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
