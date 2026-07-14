import { describe, expect, it } from "vitest";

import { createApplyBinder } from "../apply-bind.mjs";
import { assertRetainedProductAuthority } from "./retained-authority.mjs";

const product = {
  logicalKey: "product:retained",
  retainedProductId: "prod_retained_123",
  slug: "retained",
  brand: "Demo",
  media: [
    { logicalKey: "retained:primary", role: "primary" },
    { logicalKey: "retained:variant", role: "variant-black" },
  ],
  options: [{ name: "Color", values: ["Black"] }],
  variants: [{ logicalKey: "retained:black", optionValues: ["Black"] }],
};

function snapshot(mediaIds = ["media_old_primary", "media_old_variant"]) {
  return {
    productDetails: [{
      id: product.retainedProductId,
      slug: product.slug,
      attributes: [],
      options: [{ name: "Color", position: 0, values: [{ value: "Black" }] }],
      variants: [{
        id: "variant_black", imageId: "pmed_old_variant", stock: 8,
        reservedStock: 2, stockVersion: 4,
        selectedOptions: [{ position: 0, value: "Black" }],
      }],
      media: [
        { id: "pmed_old_primary", mediaId: mediaIds[0], status: "ready" },
        { id: "pmed_old_variant", mediaId: mediaIds[1], status: "ready" },
      ],
    }],
    categories: [], collections: [], attributes: [],
  };
}

const readiness = {
  assets: new Map([
    ["retained:primary", {
      mediaId: "media_new_primary",
      retainedReplacement: { productId: product.retainedProductId, mediaId: "media_old_primary" },
    }],
    ["retained:variant", {
      mediaId: "media_new_variant",
      retainedReplacement: { productId: product.retainedProductId, mediaId: "media_old_variant" },
    }],
  ]),
};

describe("retained product generated-Media replacement", () => {
  it("accepts the exact before and after states while rejecting unrelated media", () => {
    const manifest = { products: [product] };
    expect(() => assertRetainedProductAuthority(manifest, snapshot(), readiness)).not.toThrow();
    expect(() => assertRetainedProductAuthority(
      manifest,
      snapshot(["media_new_primary", "media_new_variant"]),
      readiness,
    )).not.toThrow();
    expect(() => assertRetainedProductAuthority(
      manifest,
      snapshot(["media_unknown", "media_old_variant"]),
      readiness,
    )).toThrow(/without exact replacement authority/);
  });

  it("acknowledges only removed associations that active SKUs reference", () => {
    const binder = createApplyBinder({
      manifest: { products: [product], collections: [] },
      readiness,
      snapshot: snapshot(),
    });
    const bound = binder.bind({
      logicalKey: "product:retained:base",
      method: "PUT",
      path: "/api/v1/admin/products/prod_retained_123",
      body: {
        acknowledgedSkuImageRemovalIds: {
          $ref: "current-product:retained",
          field: "removedSkuImageIds",
        },
      },
    });
    expect(bound.body.acknowledgedSkuImageRemovalIds).toEqual(["pmed_old_variant"]);
  });
});
