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
const categoryRailSource = readFileSync(
  storefrontSourcePath("components", "homepage", "HomepageCategoryRail.astro"),
  "utf8",
);
const productPageSource = readFileSync(
  storefrontSourcePath("pages", "products", "[slug].astro"),
  "utf8",
);
const collectionPageSource = readFileSync(
  storefrontSourcePath("pages", "collections", "[id].astro"),
  "utf8",
);
const categoryPageSource = readFileSync(
  storefrontSourcePath("pages", "categories", "[slug].astro"),
  "utf8",
);

describe("buyer catalog image presentation boundaries", () => {
  it.each(buyerProductImageSurfaces)(
    "keeps the complete purchased product visible in $path",
    ({ source }) => {
      expect(source).toContain("object-contain");
      expect(source).not.toContain("object-cover");
      expect(source).toContain('fit: "contain"');
      expect(source).not.toContain('fit: "cover"');
    },
  );

  it("preserves full product evidence in gallery thumbnails and social/schema images", () => {
    expect(productGallerySource).toContain('fit: "contain"');
    expect(productGallerySource).toContain('trim: "border"');
    expect(productGallerySource).toContain("object-contain");
    expect(productGallerySource).not.toContain('fit: "cover"');
    expect(productGallerySource).not.toContain("object-cover");

    expect(productPageSource).toContain('fit: "pad"');
    expect(productPageSource).not.toContain('fit: "cover"');
    expect(collectionPageSource).toContain('fit: "pad"');
  });

  it("keeps mobile product media compact without changing media geometry per selection", () => {
    expect(productGallerySource).toContain("mobile-media-stage");
    expect(productGallerySource).toContain(
      "max-height: var(--gallery-mobile-max-height)",
    );
    expect(productGallerySource).not.toContain("data-media-aspect-ratio");
  });

  it("keeps editorial category crops stable and saliency-aware", () => {
    expect(categoryRailSource.match(/width: 520/g)).toHaveLength(2);
    expect(categoryRailSource.match(/height: 620/g)).toHaveLength(2);
    expect(categoryRailSource.match(/gravity: "auto"/g)).toHaveLength(2);
    expect(categoryRailSource).not.toContain('gravity: "center"');
    expect(categoryPageSource).toContain('gravity: "auto"');
  });
});
