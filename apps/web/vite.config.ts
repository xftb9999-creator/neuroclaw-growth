import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Single source of truth for domain types (Round J, audit P0-D2).
      "@neuroclaw/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url)
      )
    }
  },
  server: {
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  },
  preview: {
    port: 4173
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
