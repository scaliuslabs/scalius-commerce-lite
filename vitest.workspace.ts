import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "apps/api/vitest.config.ts",
  "apps/storefront/vitest.config.ts",
  "packages/core/vitest.config.ts",
  "packages/shared/vitest.config.ts",
]);
