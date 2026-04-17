import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/desktop/renderer'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/desktop/renderer'),
    emptyOutDir: false,
  },
});
