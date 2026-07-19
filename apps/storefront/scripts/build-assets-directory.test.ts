import { describe, expect, it } from "vitest";

import {
  buildAssetsDirectory,
  parseGeneratedBuildId,
} from "./build-assets-directory.mjs";

describe("Storefront build-scoped asset directory", () => {
  it("places every generated asset beneath the current build identity", () => {
    expect(buildAssetsDirectory("src-0123456789abcdef")).toBe(
      "_astro/src-0123456789abcdef",
    );
  });

  it("reads the generated TypeScript build identity", () => {
    expect(
      parseGeneratedBuildId('export const BUILD_ID = "commit-0123456789abcdef";'),
    ).toBe("commit-0123456789abcdef");
  });

  it.each([
    "../previous-build",
    "build/current",
    "build id",
    "",
  ])("rejects an unsafe build identity: %s", (buildId) => {
    expect(() => buildAssetsDirectory(buildId)).toThrow(/unsafe/i);
  });
});
