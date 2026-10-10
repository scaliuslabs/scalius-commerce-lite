import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../vitest.config.ts";

// Run the related UI suite without loading example storefront iframes or
// making outbound requests. The normal test configuration stays unchanged.
export default mergeConfig(base, defineConfig({
  test: {
    maxWorkers: 2,
    setupFiles: [fileURLToPath(new URL("./offline-setup.ts", import.meta.url))],
    environmentOptions: {
      happyDOM: {
        settings: {
          disableIframePageLoading: true,
          disableCSSFileLoading: true,
          disableJavaScriptFileLoading: true,
        },
      },
    },
  },
}));
