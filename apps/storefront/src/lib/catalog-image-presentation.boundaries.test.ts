import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";

const buyerProductImageSurfaces = [
  "components/CartFlyout.tsx",
  "lib/cart/client.ts",
  "pages/account.astro",
  "pages/account/orders/[id].astro",
].map((path) => ({
  path,
  source: readFileSync(storefrontSourcePath(...path.split("/")), "utf8"),
}));

const productGallerySource = readFileSync(
  storefrontSourcePath("components", "product", "ProductGallery.astro"),
  "utf8",
);

describe("buyer catalog image presentation boundaries", () => {
  it.each(buyerProductImageSurfaces)(
    "keeps the complete purchased product visible in $path",
    ({ source }) => {
      expect(source).toContain("object-contain");
      expect(source).not.toContain("object-cover");
    },
  );

  it("preserves full product evidence in gallery thumbnails", () => {
    expect(productGallerySource).toContain("object-contain");
    expect(productGallerySource).not.toContain("object-cover");
  });

  it("keeps mobile product media compact without changing media geometry per selection", () => {
    expect(productGallerySource).toContain("mobile-media-stage");
    expect(productGallerySource).toContain(
      "max-height: var(--gallery-mobile-max-height)",
    );
    expect(productGallerySource).not.toContain("data-media-aspect-ratio");
  });
});
