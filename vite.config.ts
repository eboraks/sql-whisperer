import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'out/webview',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        resultsPanel: resolve(__dirname, 'webview/src/ResultsPanel.tsx'),
        schemaGraph: resolve(__dirname, 'webview/src/SchemaGraph.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name].[ext]',
      },
    },
    sourcemap: false,
    minify: true,
  },
  resolve: {
    alias: {
      // Allow webview to import shared types (compile only, not bundled)
    },
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
