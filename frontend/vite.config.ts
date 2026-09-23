import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: import.meta.dirname,
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
        changeOrigin: true,
      },
      "/rides": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/drivers": "http://localhost:3000",
      "/config": "http://localhost:3000",
      "/simulator": "http://localhost:3000",
      "/api": "http://localhost:3000",
      "/metrics": "http://localhost:3000",
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
});
