import { describe, expect, it } from "vitest";

import { GALLERY_CONFIG } from "./config";

describe("product gallery image budget", () => {
  it("keeps the eager mobile image within the Slow-4G transform budget", () => {
    expect(GALLERY_CONFIG.imageTransforms.mobileDisplay).toBe(420);
    expect(GALLERY_CONFIG.imageTransforms.mobileQuality).toBe(52);
  });

  it("does not overserve the product thumbnail slots", () => {
    expect(GALLERY_CONFIG.imageTransforms.preview).toBe(120);
    expect(GALLERY_CONFIG.imageTransforms.previewQuality).toBe(62);
    expect(GALLERY_CONFIG.imageTransforms.preview).toBeGreaterThanOrEqual(
      GALLERY_CONFIG.thumbnails.desktop.width,
    );
    expect(GALLERY_CONFIG.imageTransforms.preview).toBeGreaterThanOrEqual(
      GALLERY_CONFIG.thumbnails.mobile.width,
    );
  });
});
