/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  // Demo mode (in-memory fake API) is available in dev, or in a build made with VITE_DEMO=1.
  // In a normal production build the flag is a literal `false`, so the demo chunk is never emitted.
  const demoAllowed = mode !== 'production' || process.env.VITE_DEMO === '1';
  return {
    define: {
      __DEMO_ALLOWED__: JSON.stringify(demoAllowed),
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0'),
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'script-defer',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'AnyCast',
          short_name: 'AnyCast',
          description: 'Live TV, movies and series from your own server.',
          theme_color: '#0E0F11',
          background_color: '#0E0F11',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          scope: '/',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // App shell only. Never cache the API or media streams.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          globIgnores: ['**/clip-*.webm'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/cast\//],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'fonts', expiration: { maxEntries: 20 } },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
    ],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:8787', changeOrigin: false },
        // cast links a TV opens (/cast/<token>/api/stream/...)
        '/cast': { target: 'http://localhost:8787', changeOrigin: false },
      },
    },
    build: {
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 600,
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
