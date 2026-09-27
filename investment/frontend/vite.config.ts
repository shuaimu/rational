import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/rational/investment/' : '/investment/',
  resolve: { dedupe: ['@mako-cloud/rxdb', 'rxdb', 'rxjs', 'dexie', 'react', 'react-dom'] },
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../web-dist/investment', emptyOutDir: true },
  server: { port: 5174 },
}));
