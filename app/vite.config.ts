import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from https://superphant.github.io/leash-hsk/
export default defineConfig({
  base: process.env.LEASH_BASE ?? "/leash-hsk/",
  plugins: [react()],
  server: { fs: { allow: [".."] } },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
