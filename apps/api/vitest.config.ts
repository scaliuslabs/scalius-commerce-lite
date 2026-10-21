import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Lets the bundled loader's egress guard follow tests' fetch stubs.
    setupFiles: [fileURLToPath(new URL("../../scripts/vitest-setup.mjs", import.meta.url))],
  },
});
