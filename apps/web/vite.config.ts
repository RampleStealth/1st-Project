import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/client", emptyOutDir: true },
  server: { proxy: { "/v1": { target: process.env.API_ORIGIN ?? "http://localhost:4000", changeOrigin: true } } },
  test: { environment: "jsdom", globals: true }
});
