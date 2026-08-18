import { describe, expect, it } from "vitest";

import {
  CATALOG_FEED_IMAGE_OPTIONS,
  catalogFeedRowUtf8Bytes,
  catalogFeedRowsUtf8Bytes,
  projectCatalogFeedRows,
  type CatalogFeedProductInput,
} from "./catalog-feed-row";

const BASE_URL = "https://storefront.example.test";

function project(
  products: CatalogFeedProductInput[],
  overrides: Partial<Parameters<typeof projectCatalogFeedRows>[0]> = {},
) {
  return projectCatalogFeedRows({
    products,
    storefrontBaseUrl: BASE_URL,
    currencyCode: "BDT",
    policy: {
      variantStrategy: "variants",
      includeUnavailableProducts: true,
    },
    transformImageUrl: (source) => source,
    ...overrides,
  });
}

describe("catalog feed row projector", () => {
  it("projects every optional variant XML fact from one pure row authority", () => {
    const transforms: Array<{ source: string; options: unknown }> = [];
    const result = project([
      {
        id: "prod_shirt",
        name: "Oxford Shirt",
        slug: "oxford-shirt",
        canonicalPath: "/products/harbor-oxford",
        description: "<p>Soft &amp; durable</p>",
        price: 1500,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: null,
        freeDelivery: true,
        isActive: true,
        availableForSale: true,
        hasVariants: true,
        imageUrl: "https://cdn.example.test/shirt-primary.jpg",
        productCondition: "used",
        category: { slug: "electronics", name: "Wearable Electronics" },
        attributes: [
          { name: "Brand", value: "Harbor" },
          { name: "Material", value: "Cotton" },
          { name: "Gender", value: "unisex" },
          { name: "Age Group", value: "adult" },
          { name: "Pattern", value: "Oxford weave" },
        ],
        variants: [
          {
            id: "var_navy_m",
            sku: " HARBOR-NAVY-M ",
            optionCombinationKey: "val_size_m|val_color_navy",
            imageId: "pmed_navy",
            imageUrl: "/products/shirt-navy.jpg",
            selectedOptions: [
              { name: "Size", value: "M", standardMapping: "size" },
              { name: "Color", value: "Navy", standardMapping: "color" },
            ],
            price: 1200,
            stock: 4,
            reservedStock: 1,
            trackInventory: true,
            barcode: "012345678905",
            barcodeType: "upc",
            discountType: "flat",
            discountPercentage: null,
            discountAmount: 100,
            deletedAt: null,
          },
          {
            id: "var_white_l",
            sku: "HARBOR-WHITE-L",
            optionCombinationKey: "val_size_l|val_color_white",
            imageId: null,
            imageUrl: "https://ignored.example.test/white.jpg",
            selectedOptions: [
              { name: "Size", value: "L", standardMapping: "size" },
              { name: "Color", value: "White", standardMapping: "color" },
            ],
            price: 1300,
            stock: 0,
            reservedStock: 0,
            trackInventory: true,
            barcode: null,
            barcodeType: null,
            discountType: null,
            discountPercentage: null,
            discountAmount: null,
            deletedAt: null,
          },
        ],
      },
    ], {
      transformImageUrl: (source, options) => {
        transforms.push({ source, options });
        return source;
      },
    });

    expect(result.omissions).toEqual([]);
    expect(result.omissionsTruncated).toBe(false);
    expect(transforms).toEqual([
      {
        source: "/products/shirt-navy.jpg",
        options: CATALOG_FEED_IMAGE_OPTIONS,
      },
      {
        source: "https://cdn.example.test/shirt-primary.jpg",
        options: CATALOG_FEED_IMAGE_OPTIONS,
      },
    ]);

    expect(result.rows[0]).toEqual({
      kind: "variant",
      productId: "prod_shirt",
      variantId: "var_navy_m",
      id: "HARBOR-NAVY-M",
      title: "Oxford Shirt - Size: M / Color: Navy",
      description: "Soft & durable",
      link:
        "https://storefront.example.test/products/harbor-oxford?variant=var_navy_m",
      imageLink: "https://storefront.example.test/products/shirt-navy.jpg",
      availability: {
        canonical: "in_stock",
        google: "in_stock",
        meta: "in stock",
      },
      condition: "used",
      pricing: {
        currencyCode: "BDT",
        originalAmount: 1200,
        currentAmount: 1100,
        price: "1200.00 BDT",
        salePrice: "1100.00 BDT",
        currentPrice: "1100.00 BDT",
      },
      brand: "Harbor",
      gtin: "012345678905",
      identifierExists: null,
      itemGroupId: "prod_shirt",
      itemGroupTitle: "Oxford Shirt",
      variantOptions: [
        { name: "Size", value: "M" },
        { name: "Color", value: "Navy" },
      ],
      googleProductCategory: "Electronics",
      facebookProductCategory: "Electronics & Accessories",
      productType: "Wearable Electronics",
      standardAttributes: [
        { name: "size", value: "M" },
        { name: "color", value: "Navy" },
        { name: "material", value: "Cotton" },
        { name: "gender", value: "unisex" },
        { name: "age_group", value: "adult" },
        { name: "pattern", value: "Oxford weave" },
      ],
      shipping: {
        country: "BD",
        service: "Standard",
        price: "0.00 BDT",
      },
    });

    expect(result.rows[1]).toMatchObject({
      id: "HARBOR-WHITE-L",
      imageLink: "https://cdn.example.test/shirt-primary.jpg",
      availability: {
        canonical: "out_of_stock",
        google: "out_of_stock",
        meta: "out of stock",
      },
      pricing: {
        price: "1300.00 BDT",
        salePrice: "1170.00 BDT",
        currentPrice: "1170.00 BDT",
      },
    });
  });

  it("projects product strategy identity, simple GTIN, and identifier omission truth", () => {
    const [withGtin, withoutIdentity] = project([
      {
        id: "prod_simple",
        name: "Simple Camera",
        slug: "simple-camera",
        description: null,
        price: 8000,
        hasVariants: true,
        imageUrl: "https://cdn.example.test/camera.jpg",
        attributes: [
          { name: "Color", value: "Black" },
          { name: "Size", value: "Standard" },
          { name: "Material", value: "Metal" },
        ],
        variants: [{
          id: "var_default",
          isDefault: true,
          optionCombinationKey: null,
          selectedOptions: [],
          price: 8000,
          stock: 1,
          barcode: "9781234567890",
          barcodeType: "isbn",
          deletedAt: null,
        }],
      },
      {
        id: "prod_plain",
        name: "Plain Product",
        slug: "plain-product",
        description: "Plain",
        price: 500,
        hasVariants: false,
        imageUrl: "https://cdn.example.test/plain.jpg",
      },
    ], {
      policy: {
        variantStrategy: "products",
        includeUnavailableProducts: true,
      },
    }).rows;

    expect(withGtin).toMatchObject({
      kind: "product",
      id: "prod_simple",
      title: "Simple Camera",
      description: "Simple Camera",
      gtin: "9781234567890",
      identifierExists: null,
      itemGroupId: "prod_simple",
      itemGroupTitle: null,
      variantOptions: [],
      standardAttributes: [
        { name: "color", value: "Black" },
        { name: "size", value: "Standard" },
        { name: "material", value: "Metal" },
      ],
    });
    expect(withoutIdentity).toMatchObject({
      gtin: null,
      brand: null,
      identifierExists: "no",
      itemGroupId: null,
      condition: null,
    });
  });

  it("reports bounded, row-specific omission reasons without fabricating rows", () => {
    const result = project([
      {
        id: "excluded",
        name: "Excluded",
        slug: "excluded",
        price: 100,
        excludeFromProductFeed: true,
        imageUrl: "https://cdn.example.test/excluded.jpg",
      },
      {
        id: "inactive",
        name: "Inactive",
        slug: "inactive",
        price: 100,
        isActive: false,
        imageUrl: "https://cdn.example.test/inactive.jpg",
      },
      {
        id: "sold-out",
        name: "Sold Out",
        slug: "sold-out",
        price: 100,
        availableForSale: false,
        imageUrl: "https://cdn.example.test/sold-out.jpg",
      },
      {
        id: "image-less",
        name: "No Image",
        slug: "no-image",
        price: 100,
      },
      {
        id: "free",
        name: "Free",
        slug: "free",
        price: 0,
        imageUrl: "https://cdn.example.test/free.jpg",
      },
      {
        id: "bad-shape",
        name: "Bad Shape",
        slug: "bad-shape",
        price: 100,
        hasVariants: true,
        imageUrl: "https://cdn.example.test/bad-shape.jpg",
        variants: [],
      },
    ], {
      policy: {
        variantStrategy: "variants",
        includeUnavailableProducts: false,
      },
      maxReportedOmissions: 4,
    });

    expect(result.rows).toEqual([]);
    expect(result.omissions).toEqual([
      {
        productId: "excluded",
        variantId: null,
        reason: "excluded_from_product_feed",
      },
      {
        productId: "inactive",
        variantId: null,
        reason: "inactive_product",
      },
      {
        productId: "sold-out",
        variantId: null,
        reason: "unavailable_product",
      },
      {
        productId: "image-less",
        variantId: null,
        reason: "missing_image",
      },
    ]);
    expect(result.omissionsTruncated).toBe(true);
  });

  it("sizes exact untruncated UTF-8 rows deterministically", () => {
    const description = "ক".repeat(20_000);
    const [row] = project([{
      id: "large-description",
      name: "Large Description",
      slug: "large-description",
      description,
      price: 100,
      imageUrl: "https://cdn.example.test/large.jpg",
    }]).rows;

    expect(row?.description).toBe(description);
    expect(catalogFeedRowUtf8Bytes(row!)).toBe(
      new TextEncoder().encode(JSON.stringify(row)).byteLength,
    );
    expect(catalogFeedRowsUtf8Bytes([row!])).toBe(
      new TextEncoder().encode(JSON.stringify([row])).byteLength,
    );
    expect(catalogFeedRowUtf8Bytes(row!)).toBeGreaterThan(48 * 1024);
  });

  it("uses exact variant image authority and falls back only to the primary", () => {
    const result = project([{
      id: "prod_lamp",
      name: "Lamp",
      slug: "lamp",
      price: 100,
      hasVariants: true,
      imageUrl: "https://cdn.example.test/lamp-primary.jpg",
      variants: [{
        id: "var_gloss",
        sku: "LAMP-GLOSS",
        optionCombinationKey: "gloss",
        imageId: "pmed_gloss",
        imageUrl: "//untrusted.example.test/lamp.jpg",
        selectedOptions: [
          { name: "Finish", value: "Gloss", standardMapping: "material" },
        ],
        price: 100,
        stock: 1,
        deletedAt: null,
      }],
    }]);

    expect(result.rows[0]?.imageLink).toBe(
      "https://cdn.example.test/lamp-primary.jpg",
    );
    expect(result.rows[0]?.imageLink).not.toContain("untrusted.example.test");
  });
});
