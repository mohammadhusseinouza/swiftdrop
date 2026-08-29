import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Dev proxy: forwards same-origin `/api/*` calls to the backend. The
    // backend currently ships NO CORS middleware, so for browser development
    // set VITE_API_BASE_URL=/api/v1 to route through this proxy (same-origin,
    // the HttpOnly refresh cookie works, no CORS needed). The default
    // absolute VITE_API_BASE_URL bypasses the proxy and is used for Node
    // tooling / tests, or once the backend enables CORS (Phase 16).
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
