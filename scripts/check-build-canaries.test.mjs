import { describe, expect, it } from "vitest";

import { runCanaryBuild } from "./check-build-canaries.mjs";

// A real `astro build` of a throwaway copy of the storefront with canary
// .dev.vars/.env* files, canary shell secrets, and a probe route that reads
// them through import.meta.env. None may reach dist/ (server or client).
describe("storefront canary build", () => {
  it("inlines no local env value", () => {
    expect(runCanaryBuild("storefront", { log: () => {} })).toEqual([]);
  }, 300_000);
});
