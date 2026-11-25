import { defineConfig } from 'vite';

// TUNNEL=1 (ustawiane przez "npm run dev:discord") – strona idzie przez tunel
// Cloudflare i Discorda, więc przeładowywanie na żywo musi łączyć się po porcie 443.
const tunnel = process.env.TUNNEL === '1';

export default defineConfig({
  root: 'client',
  envDir: '..', // plik .env leży w głównym folderze projektu
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    // Vite domyślnie blokuje obce domeny – dopuszczamy tunele Cloudflare.
    // Jeśli masz własną domenę, dopisz ją tutaj.
    allowedHosts: ['.trycloudflare.com', '.discordsays.com'],
    hmr: tunnel ? { clientPort: 443 } : true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
