import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri loads the dev server at a fixed port, so a busy port must fail instead of moving.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // A desktop app loads its bundle from disk, so big chunks (xterm, later Monaco) are fine.
  build: { target: "safari16", outDir: "dist", chunkSizeWarningLimit: 8000 },
});
