import { describe, expect, it } from "vitest";
import { MEDIA_VARIANT_WIDTHS } from "@scalius/shared/media-variants";

import { GALLERY_CONFIG } from "./config";

describe("product gallery image budget", () => {
  it("maps every gallery slot onto a pre-generated rendition width", () => {
    for (const width of Object.values(GALLERY_CONFIG.imageWidths)) {
      expect(MEDIA_VARIANT_WIDTHS).toContain(width);
    }
  });

  it("keeps the eager mobile image on the smallest step that covers a DPR 2 phone slot", () => {
    expect(GALLERY_CONFIG.imageWidths.mobileDisplay).toBe(480);
  });

  it("does not overserve the product thumbnail slots", () => {
    expect(GALLERY_CONFIG.imageWidths.preview).toBe(160);
    expect(GALLERY_CONFIG.imageWidths.preview).toBeGreaterThanOrEqual(
      GALLERY_CONFIG.thumbnails.desktop.width,
    );
    expect(GALLERY_CONFIG.imageWidths.preview).toBeGreaterThanOrEqual(
      GALLERY_CONFIG.thumbnails.mobile.width,
    );
  });
});
