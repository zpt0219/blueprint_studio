import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// base: "./" keeps asset URLs relative so the built tool works from any
// subpath (GitHub Pages /blueprint_studio, file://, etc.).
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
  },
  resolve: {
    alias: {
      "@lib": path.resolve(__dirname, "./src/shared"),
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three/")) return "three";
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) return "react-vendor";
          if (id.includes("node_modules/fflate/")) return "zip";
        },
      },
    },
  },
});
