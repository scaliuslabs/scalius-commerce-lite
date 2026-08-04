import { describe, expect, it } from "vitest";

import { GALLERY_CONFIG } from "./config";

describe("product gallery image budget", () => {
  it("keeps the eager mobile image within the verified Slow-4G transform budget", () => {
    expect(GALLERY_CONFIG.imageTransforms.mobileDisplay).toBe(480);
    expect(GALLERY_CONFIG.imageTransforms.mobileQuality).toBe(68);
  });
});
