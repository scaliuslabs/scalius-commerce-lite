import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".wrangler"],
  },
  resolve: {
    alias: {
      "@/": path.resolve(__dirname, "../src") + "/",
      "@modules/": path.resolve(__dirname, "../src/modules") + "/",
      "@db/": path.resolve(__dirname, "../src/db") + "/",
      "@shared/": path.resolve(__dirname, "../src/shared") + "/",
    },
  },
});
