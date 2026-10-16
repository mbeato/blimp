import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The dev server's hot reload talks over ws://localhost, which the CSP in index.html doesn't allow.
// Allow it in dev only. (React's inline refresh preamble sits above the CSP meta, so the policy
// doesn't apply to it.)
const devCsp: Plugin = {
  name: "blimp-dev-csp",
  apply: "serve",
  transformIndexHtml: (html) => html.replace("connect-src 'self'", "connect-src 'self' ws://localhost:*"),
};

// Tauri loads the dev server at a fixed port, so a busy port must fail instead of moving.
export default defineConfig({
  plugins: [react(), devCsp],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // A desktop app loads its bundle from disk, so big chunks (xterm, later Monaco) are fine.
  build: { target: "safari16", outDir: "dist", chunkSizeWarningLimit: 8000 },
});
