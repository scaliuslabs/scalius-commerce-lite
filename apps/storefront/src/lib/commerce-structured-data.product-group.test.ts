import { describe, expect, it } from "vitest";

// @ts-expect-error -- the release smoke is a plain ESM script without types.
import { evaluateProductJsonLdHtml } from "../../../../scripts/release-check.mjs";
import {
  PRODUCT_JSON_LD_DESCRIPTION_MAX_CHARS,
  PRODUCT_JSON_LD_MAX_BYTES,
  buildOfferShippingDetails,
  buildProductGroupJsonLd,
  productSchemaDescription,
  type ProductGroupVariantSchema,
} from "./commerce-structured-data";
import { serializeJsonForInlineScript } from "./safe-json";

const STORE = "https://shop.example.com";
const PRODUCT_URL = `${STORE}/products/college-bag`;
const IMAGES = Array.from({ length: 8 }, (_, index) =>
  `https://cdn.example.com/media/media_photo${index}xx.jpg/2400.webp`);
// A long rich description, like the live 20-variant product's (about 4 KB).
const RICH_DESCRIPTION = `<h2>College bag</h2>${"<p>Water resistant &amp; roomy. <strong>Fits a 15&quot; laptop</strong>, bottle pockets and a padded back.</p>".repeat(40)}`;

const shipping = buildOfferShippingDetails({
  shippingMethods: [
    { id: "in", name: "Inside Dhaka", fee: 60, isActive: true },
    { id: "out", name: "Outside Dhaka", fee: 120, isActive: true },
  ] as never,
  currencyCode: "BDT",
  freeDelivery: false,
  country: "BD",
});

function variants(count: number): ProductGroupVariantSchema[] {
  return Array.from({ length: count }, (_, index) => {
    const url = `${PRODUCT_URL}?variant=var_${index}`;
    return {
      name: `College bag - Color: Shade ${index} / Size: ${index % 2 ? "L" : "M"}`,
      url,
      sku: `BAG-${index}`,
      image: index % 3 === 0 ? `https://cdn.example.com/media/media_var${index}xxxx.jpg/1600.webp` : null,
      properties: { color: `Shade ${index}`, size: index % 2 ? "L" : "M" },
      offer: {
        "@type": "Offer",
        url,
        priceCurrency: "BDT",
        price: "1450.00",
        availability: index % 4 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        seller: { "@type": "Organization", name: "Scalius Mart" },
        shippingDetails: shipping,
      },
    };
  });
}

function group(count: number) {
  return buildProductGroupJsonLd({
    name: "College bag",
    url: PRODUCT_URL,
    description: productSchemaDescription(RICH_DESCRIPTION, "College bag"),
    images: IMAGES,
    productGroupID: "prod_bag",
    brandName: "Scalius",
    variesBy: ["https://schema.org/color", "https://schema.org/size"],
    variants: variants(count),
  });
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(serializeJsonForInlineScript(value)).byteLength;
}

function smoke(value: unknown) {
  return evaluateProductJsonLdHtml(
    `<script type="application/ld+json">${serializeJsonForInlineScript(value)}</script>`,
    { storefrontOrigin: STORE },
  );
}

describe("productSchemaDescription", () => {
  it("flattens rich text to plain text with entities decoded", () => {
    expect(productSchemaDescription("<p>Fits a 15&quot; laptop &amp; more</p>", "x")).toBe("Fits a 15\" laptop & more");
    expect(productSchemaDescription("", "College bag")).toBe("College bag");
  });

  it("caps a long description at a word boundary", () => {
    const text = productSchemaDescription(RICH_DESCRIPTION, "College bag");
    expect(text.length).toBeLessThanOrEqual(PRODUCT_JSON_LD_DESCRIPTION_MAX_CHARS + 1);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toMatch(/<|&amp;/);
  });
});

describe("buildProductGroupJsonLd", () => {
  it("states the description, brand and photo list once, never per variant", () => {
    const jsonLd = group(20);
    const serialized = JSON.stringify(jsonLd);

    expect(jsonLd.hasVariant).toHaveLength(20);
    expect(serialized.split('"description"')).toHaveLength(2);
    expect(serialized.split('"brand"')).toHaveLength(2);
    for (const variant of jsonLd.hasVariant) {
      expect(variant).not.toHaveProperty("description");
      expect(variant).not.toHaveProperty("brand");
      expect(typeof (variant as { image?: unknown }).image).toBe("string");
    }
    // A SKU without its own photo shows the group's first photo.
    expect(jsonLd.hasVariant[1]!.image).toBe(IMAGES[0]);
    expect(jsonLd.hasVariant[0]!.image).toContain("media_var0");
  });

  it("keeps a 20-variant product with a long description under the 20 KB budget and passes the release smoke", () => {
    const jsonLd = group(20);
    expect(bytes(jsonLd)).toBeLessThanOrEqual(PRODUCT_JSON_LD_MAX_BYTES);
    const result = smoke(jsonLd);
    expect(result.errors).toEqual([]);
    expect(result.offerCount).toBe(20);
    expect(result.shippingDetailsCount).toBe(40);
  });

  it("lists only the complete variants that fit when a large product would exceed the budget", () => {
    const jsonLd = group(100);
    expect(bytes(jsonLd)).toBeLessThanOrEqual(PRODUCT_JSON_LD_MAX_BYTES);
    expect(jsonLd.hasVariant.length).toBeGreaterThan(10);
    expect(jsonLd.hasVariant.length).toBeLessThan(100);
    expect(jsonLd.hasVariant.map((variant) => variant.sku)).toEqual(
      variants(jsonLd.hasVariant.length).map((variant) => variant.sku),
    );
    expect(smoke(jsonLd).errors).toEqual([]);
  });

  it("always lists at least one variant", () => {
    const jsonLd = buildProductGroupJsonLd({
      name: "College bag",
      url: PRODUCT_URL,
      description: "",
      images: IMAGES,
      productGroupID: "prod_bag",
      brandName: null,
      variesBy: [],
      variants: variants(3),
      maxBytes: 10,
    });
    expect(jsonLd.hasVariant).toHaveLength(1);
    expect(jsonLd).not.toHaveProperty("description");
    expect(jsonLd).not.toHaveProperty("brand");
  });
});
