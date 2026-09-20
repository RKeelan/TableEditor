import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The build is one self-contained index.html with the JS and CSS inlined,
// written to ../assets/index.html, which the crate embeds with include_str!.
// The directory is not emptied first, because the crate's own files live there.
//
// In development Vite serves the UI and proxies /api to a running server; the
// example consumer binds 8791 (see the README).
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: "../assets",
    emptyOutDir: false,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8791",
    },
  },
});
