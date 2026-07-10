import { describe, expect, it } from "vitest";
import { appendStorefrontAssistantCatalogReferences } from
  "@scalius/shared/storefront-assistant-references";

import type {
  StorefrontChatPayload,
  StorefrontMcpContext,
} from "./storefront-chat-contract";
import { buildStorefrontAssistantResponse } from
  "./storefront-chat-parts";

const ORIGIN = "https://storefront.example.test";

function payload(
  message: string,
  surface?: NonNullable<StorefrontChatPayload["pageContext"]>["surface"],
): StorefrontChatPayload {
  return {
    messages: [{ role: "user", content: message }],
    pageContext: {
      version: 1,
      contextVersion: 2,
      source: "storefront",
      page: {
        path: "/products/khaki-shoes",
        title: "mhgvhgv",
        kind: surface?.kind ?? "product",
      },
      ...(surface ? { surface } : {}),
    },
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://scalius/product/prod_khaki",
    title: "Khaki High-Top Casual Shoes For Mens",
    url: `${ORIGIN}/products/khaki-high-top-casual-shoes-for-men`,
    handle: "khaki-high-top-casual-shoes-for-men",
    description: { plain: "Casual shoes" },
    price_range: {
      min: { amount: 4_104_000, currency: "BDT" },
      max: { amount: 4_200_000, currency: "BDT" },
    },
    list_price_range: {
      min: { amount: 4_500_000, currency: "BDT" },
      max: { amount: 4_600_000, currency: "BDT" },
    },
    options: [
      { name: "Size", values: [{ label: "42" }, { label: "43" }] },
      { name: "Color", values: [{ label: "Brown" }, { label: "Blue" }] },
    ],
    media: [{
      type: "image",
      url: "https://cdn.example.test/products/khaki-main.jpg",
    }],
    metadata: { product_id: "prod_khaki", available_for_sale: true },
    variants: [
      {
        id: "gid://scalius/product-variant/var_brown",
        title: "Khaki shoes - 42 / Brown",
        price: { amount: 4_104_000, currency: "BDT" },
        availability: { available: false, status: "out_of_stock" },
        options: [
          { name: "Size", label: "42" },
          { name: "Color", label: "Brown" },
        ],
        media: [{
          type: "image",
          url: "https://cdn.example.test/products/khaki-brown.jpg",
        }],
        metadata: { variant_id: "var_brown", available_quantity: 8 },
      },
      {
        id: "gid://scalius/product-variant/var_blue",
        title: "Khaki shoes - 43 / Blue",
        price: { amount: 4_200_000, currency: "BDT" },
        list_price: { amount: 4_600_000, currency: "BDT" },
        availability: { available: false, status: "out_of_stock" },
        options: [
          { name: "Size", label: "43" },
          { name: "Color", label: "Blue" },
        ],
        media: [{
          type: "image",
          url: "https://cdn.example.test/products/khaki-blue.jpg",
        }],
        metadata: { variant_id: "var_blue", available_quantity: 0 },
      },
    ],
    ...overrides,
  };
}

function context(
  tool: StorefrontMcpContext["tool"],
  structuredContent: Record<string, unknown>,
): StorefrontMcpContext {
  return { tool, structuredContent, text: `${tool}: verified` };
}

describe("authoritative storefront assistant rich parts", () => {
  it("overrides stale page title and raw display price with the exact selected UCP variant", () => {
    const response = buildStorefrontAssistantResponse({
      modelText: "This is mhgvhgv and costs 999.",
      contexts: [
        context("catalog_product", {
          ucp: { status: "success", version: "2026-04-08" },
          product: product(),
        }),
      ],
      payload: payload("What am I looking at?", {
        kind: "product",
        productId: "prod_khaki",
        selectedVariantId: "var_blue",
        selectedOptions: [
          { name: "Size", label: "43" },
          { name: "Color", label: "Blue" },
        ],
        displayedPrice: 999,
        availability: "selection_required",
      }),
      origin: ORIGIN,
      searchQuery: null,
    });

    expect(response.text).toContain("Khaki High-Top Casual Shoes For Mens");
    expect(response.text).toContain("42,000.00");
    expect(response.text).toContain("out of stock");
    expect(response.text).not.toContain("mhgvhgv");
    expect(response.text).not.toContain("999");
    expect(response.parts[1]).toMatchObject({
      type: "product_grid",
      products: [{
        price: 42_000,
        compareAtPrice: 46_000,
        currency: "BDT",
        pricePresentation: "exact",
        availability: "out_of_stock",
        selectedVariantId: "gid://scalius/product-variant/var_blue",
        imageUrl: "https://cdn.example.test/products/khaki-blue.jpg",
        badges: ["Size: 43", "Color: Blue"],
      }],
    });
  });

  it("uses the UCP price range and real option axes when selection is required", () => {
    const response = buildStorefrontAssistantResponse({
      modelText: "I cannot verify this page.",
      contexts: [context("catalog_product", {
        ucp: { status: "success", version: "2026-04-08" },
        product: product(),
      })],
      payload: payload("What am I looking at?", {
        kind: "product",
        productId: "prod_khaki",
        selectedOptions: [],
        displayedPrice: 1,
        availability: "selection_required",
      }),
      origin: ORIGIN,
      searchQuery: null,
    });

    expect(response.text).toContain("41,040.00");
    expect(response.text).toContain("prices start at");
    expect(response.text).toContain("Choose Size and Color");
    expect(response.parts[1]).toMatchObject({
      type: "product_grid",
      products: [{
        price: 41_040,
        pricePresentation: "starting_at",
        availability: "in_stock",
      }],
    });
    if (response.parts[1]?.type !== "product_grid") {
      throw new Error("Expected product grid");
    }
    expect(response.parts[1].products[0]).not.toHaveProperty("compareAtPrice");
  });

  it("preserves grounded model guidance for non-factual current-product questions", () => {
    const response = buildStorefrontAssistantResponse({
      modelText:
        "These casual shoes are not described as hiking footwear, so I would not assume trail suitability.",
      contexts: [context("catalog_product", {
        ucp: { status: "success", version: "2026-04-08" },
        product: product(),
      })],
      payload: payload("Is this good for hiking?", {
        kind: "product",
        productId: "prod_khaki",
        selectedOptions: [],
        displayedPrice: 1,
        availability: "selection_required",
      }),
      origin: ORIGIN,
      searchQuery: "hiking",
    });

    expect(response.deterministic).toBe(false);
    expect(response.text).toBe(
      "These casual shoes are not described as hiking footwear, so I would not assume trail suitability.",
    );
    expect(response.parts[1]).toMatchObject({ type: "product_grid" });
  });

  it("answers a natural catalog question deterministically and emits bounded product cards", () => {
    const duplicate = product();
    const second = product({
      id: "gid://scalius/product/prod_runner",
      title: "Everyday Running Shoes",
      url: `${ORIGIN}/products/everyday-running-shoes`,
      handle: "everyday-running-shoes",
    });
    const unsafe = product({
      id: "gid://scalius/product/prod_unsafe",
      title: "Unsafe",
      url: "https://evil.example.test/products/unsafe",
    });
    const response = buildStorefrontAssistantResponse({
      modelText: "I cannot verify that from the current page context.",
      contexts: [context("catalog_search", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [duplicate, duplicate, second, unsafe],
        pagination: { total_count: 3 },
      })],
      payload: payload("Do you sell any shoes?"),
      origin: ORIGIN,
      searchQuery: "shoes",
    });

    expect(response.text).toBe(
      "I found 2 current catalog matches for “shoes”. Prices and availability below come from the public catalog.",
    );
    expect(response.parts[1]).toMatchObject({
      type: "product_grid",
      title: "Matches for “shoes”",
    });
    if (response.parts[1]?.type !== "product_grid") {
      throw new Error("Expected product grid");
    }
    expect(response.parts[1].products.map((item) => item.title)).toEqual([
      "Khaki High-Top Casual Shoes For Mens",
      "Everyday Running Shoes",
    ]);
  });

  it("preserves trusted persisted SKU IDs that resemble secret tokens", () => {
    const variantId =
      "gid://scalius/product-variant/var_default_771c03fc4744ac84bee8e3a8";
    const response = buildStorefrontAssistantResponse({
      modelText: "",
      contexts: [context("catalog_search", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [product({
          id: "gid://scalius/product/prod_miLvKbzvhtRXN6TCQwhgc",
          title: "Everyday Loafers",
          url: `${ORIGIN}/products/everyday-loafers`,
          handle: "everyday-loafers",
          options: [],
          price_range: {
            min: { amount: 170_000, currency: "BDT" },
            max: { amount: 170_000, currency: "BDT" },
          },
          variants: [{
            id: variantId,
            price: { amount: 170_000, currency: "BDT" },
            availability: { available: true, status: "in_stock" },
            metadata: {
              product_id: "prod_miLvKbzvhtRXN6TCQwhgc",
              variant_id: "var_default_771c03fc4744ac84bee8e3a8",
            },
          }],
        })],
      })],
      payload: payload("Do you sell shoes?"),
      origin: ORIGIN,
      searchQuery: "shoes",
    });

    expect(response.deterministic).toBe(true);
    expect(response.hasCatalogFacts).toBe(true);
    expect(response.text).toContain("Everyday Loafers");
    expect(response.parts[1]).toMatchObject({
      type: "product_grid",
      products: [{ selectedVariantId: variantId }],
    });
    expect(JSON.stringify(response)).not.toContain("[redacted-token]");
  });

  it("keeps recommendation reasoning model-backed while attaching verified cards", () => {
    const response = buildStorefrontAssistantResponse({
      modelText:
        "For travel, the lighter option is the stronger fit based on the catalog details shown.",
      contexts: [context("catalog_search", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [product()],
      })],
      payload: payload("Recommend shoes for travel"),
      origin: ORIGIN,
      searchQuery: "shoes travel",
    });

    expect(response.deterministic).toBe(false);
    expect(response.text).toContain("For travel");
    expect(response.parts[1]).toMatchObject({ type: "product_grid" });
  });

  it("prioritizes current-product option facts over a coincidental search", () => {
    const response = buildStorefrontAssistantResponse({
      modelText: "Search says something else.",
      contexts: [
        context("catalog_product", {
          ucp: { status: "success", version: "2026-04-08" },
          product: product(),
        }),
        context("catalog_search", {
          ucp: { status: "success", version: "2026-04-08" },
          products: [product({
            id: "gid://scalius/product/prod_size_chart",
            title: "Generic size chart",
            url: `${ORIGIN}/products/generic-size-chart`,
          })],
        }),
      ],
      payload: payload("What sizes do you have?", {
        kind: "product",
        productId: "prod_khaki",
        selectedOptions: [],
        displayedPrice: 1,
        availability: "selection_required",
      }),
      origin: ORIGIN,
      searchQuery: "sizes",
    });

    expect(response.deterministic).toBe(true);
    expect(response.text).toContain("Size: 42, 43");
    expect(response.text).not.toContain("Generic size chart");
  });

  it("keeps use-case comparisons model-backed while retaining catalog rows", () => {
    const response = buildStorefrontAssistantResponse({
      modelText: "For hiking, the runner is the better fit based on the listed details.",
      contexts: [context("catalog_lookup", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [
          product(),
          product({
            id: "gid://scalius/product/prod_runner",
            title: "Trail Runner",
            url: `${ORIGIN}/products/trail-runner`,
          }),
        ],
      })],
      payload: payload("Which is better for hiking?", {
        kind: "category",
        categoryId: "cat_shoes",
        slug: "shoes",
        visibleProductIds: ["prod_khaki", "prod_runner"],
        visibleFilters: [],
        totalResults: 2,
        page: 1,
      }),
      origin: ORIGIN,
      searchQuery: "hiking",
    });

    expect(response.deterministic).toBe(false);
    expect(response.text).toContain("For hiking");
    expect(response.parts[1]).toMatchObject({ type: "comparison" });
  });

  it("emits semantic comparison rows from UCP facts without model calculations", () => {
    const response = buildStorefrontAssistantResponse({
      modelText: "Maybe one is better.",
      contexts: [context("catalog_lookup", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [
          product(),
          product({
            id: "gid://scalius/product/prod_runner",
            title: "Everyday Running Shoes",
            url: `${ORIGIN}/products/everyday-running-shoes`,
            handle: "everyday-running-shoes",
          }),
        ],
      })],
      payload: payload("Compare these shoes"),
      origin: ORIGIN,
      searchQuery: null,
    });

    expect(response.parts[1]).toMatchObject({
      type: "comparison",
      title: "Catalog comparison",
      rows: [
        { label: "Price" },
        { label: "Availability" },
        { label: "Options" },
      ],
    });
  });

  it("returns a truthful deterministic empty-search answer", () => {
    const response = buildStorefrontAssistantResponse({
      modelText: "Try searching manually.",
      contexts: [context("catalog_search", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [],
        pagination: { total_count: 0 },
      })],
      payload: payload("Do you sell moon boots?"),
      origin: ORIGIN,
      searchQuery: "moon boots",
    });

    expect(response).toMatchObject({
      text: "I couldn’t find a current catalog match for “moon boots”.",
      deterministic: true,
      hasCatalogFacts: true,
      parts: [{
        type: "text",
        text: "I couldn’t find a current catalog match for “moon boots”.",
      }],
    });
  });

  it("does not turn malformed nonempty search rows into verified no matches", () => {
    const response = buildStorefrontAssistantResponse({
      modelText: "I couldn’t verify the catalog response, so I won’t claim there are no matches.",
      contexts: [context("catalog_search", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [{ title: "Missing identity and path" }],
      })],
      payload: payload("Do you sell moon boots?"),
      origin: ORIGIN,
      searchQuery: "moon boots",
    });

    expect(response.deterministic).toBe(false);
    expect(response.hasCatalogFacts).toBe(false);
    expect(response.text).toContain("couldn’t verify");
    expect(response.text).not.toContain("couldn’t find a current catalog match");
    expect(response.parts).toHaveLength(1);
  });

  it("uses three-decimal currencies and never invents missing currency", () => {
    const kwd = product({
      id: "gid://scalius/product/prod_kwd",
      title: "Kuwaiti product",
      url: `${ORIGIN}/products/kuwaiti-product`,
      price_range: {
        min: { amount: 1_234, currency: "KWD" },
        max: { amount: 1_500, currency: "KWD" },
      },
      variants: [],
    });
    const noCurrency = product({
      id: "gid://scalius/product/prod_no_currency",
      title: "Unpriced product",
      url: `${ORIGIN}/products/unpriced-product`,
      price_range: { min: { amount: 1_234 } },
      variants: [],
    });
    const response = buildStorefrontAssistantResponse({
      modelText: "",
      contexts: [context("catalog_search", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [kwd, noCurrency],
      })],
      payload: payload("Show me products"),
      origin: ORIGIN,
      searchQuery: "products",
    });

    expect(response.text).toContain("2 current catalog matches");
    if (response.parts[1]?.type !== "product_grid") {
      throw new Error("Expected product grid");
    }
    expect(response.parts[1].products[0]).toMatchObject({
      price: 1.234,
      currency: "KWD",
      pricePresentation: "starting_at",
    });
    expect(response.parts[1].products[1]).not.toHaveProperty("price");
    expect(response.parts[1].products[1]).not.toHaveProperty("currency");
  });

  it("distinguishes featured UCP variants from exact variant inputs", () => {
    const featured = product({
      id: "gid://scalius/product/prod_featured",
      title: "Featured shoes",
      url: `${ORIGIN}/products/featured-shoes`,
      variants: [{
        id: "gid://scalius/product-variant/featured_m",
        price: { amount: 4_104_000, currency: "BDT" },
        list_price: { amount: 4_600_000, currency: "BDT" },
        options: [{ name: "Size", label: "M" }],
        inputs: [{
          id: "gid://scalius/product/prod_featured",
          match: "featured",
        }],
        availability: { available: true, status: "in_stock" },
      }],
    });
    const exact = product({
      id: "gid://scalius/product/prod_exact",
      title: "Exact shoes",
      url: `${ORIGIN}/products/exact-shoes`,
      variants: [{
        id: "gid://scalius/product-variant/exact_m",
        price: { amount: 4_200_000, currency: "BDT" },
        list_price: { amount: 4_600_000, currency: "BDT" },
        options: [{ name: "Size", label: "M" }],
        inputs: [{
          id: "gid://scalius/product-variant/exact_m",
          match: "exact",
        }],
        availability: { available: false, status: "out_of_stock" },
      }],
    });
    const featuredUnavailable = product({
      id: "gid://scalius/product/prod_featured_unavailable",
      title: "Unavailable featured shoes",
      url: `${ORIGIN}/products/unavailable-featured-shoes`,
      metadata: {
        product_id: "prod_featured_unavailable",
        available_for_sale: false,
      },
      variants: [{
        id: "gid://scalius/product-variant/featured_available_row",
        price: { amount: 4_104_000, currency: "BDT" },
        options: [{ name: "Size", label: "M" }],
        inputs: [{
          id: "gid://scalius/product/prod_featured_unavailable",
          match: "featured",
        }],
        availability: { available: true, status: "in_stock" },
      }],
    });
    const response = buildStorefrontAssistantResponse({
      modelText: "Here are the visible products.",
      contexts: [context("catalog_lookup", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [featured, exact, featuredUnavailable],
      })],
      payload: payload("What about these?", {
        kind: "category",
        categoryId: "cat_shoes",
        slug: "shoes",
        visibleProductIds: [
          "prod_featured",
          "exact_m",
          "prod_featured_unavailable",
        ],
        visibleFilters: [],
        totalResults: 3,
        page: 1,
      }),
      origin: ORIGIN,
      searchQuery: null,
    });

    if (response.parts[1]?.type !== "product_grid") {
      throw new Error("Expected product grid");
    }
    expect(response.parts[1].products[0]).toMatchObject({
      pricePresentation: "starting_at",
      availability: "in_stock",
      badges: [],
    });
    expect(response.parts[1].products[0]).not.toHaveProperty("compareAtPrice");
    expect(response.parts[1].products[0]).not.toHaveProperty("selectedVariantId");
    expect(response.parts[1].products[1]).toMatchObject({
      pricePresentation: "exact",
      compareAtPrice: 46_000,
      selectedVariantId: "gid://scalius/product-variant/exact_m",
      availability: "out_of_stock",
      badges: ["Size: M"],
    });
    expect(response.parts[1].products[2]).toMatchObject({
      pricePresentation: "starting_at",
      availability: "out_of_stock",
      badges: [],
    });
  });

  it("requires all product option axes before treating selected options as exact", () => {
    const response = buildStorefrontAssistantResponse({
      modelText: "",
      contexts: [context("catalog_product", {
        ucp: { status: "success", version: "2026-04-08" },
        product: product(),
      })],
      payload: payload("What colors do you have?", {
        kind: "product",
        productId: "prod_khaki",
        selectedOptions: [{ name: "Size", label: "43" }],
        displayedPrice: 42_000,
        availability: "selection_required",
      }),
      origin: ORIGIN,
      searchQuery: "colors",
    });

    expect(response.text).toContain("Color: Brown, Blue");
    if (response.parts[1]?.type !== "product_grid") {
      throw new Error("Expected product grid");
    }
    expect(response.parts[1].products[0]).toMatchObject({
      pricePresentation: "starting_at",
      availability: "in_stock",
    });
    expect(response.parts[1].products[0]).not.toHaveProperty("compareAtPrice");
    expect(response.parts[1].products[0]).not.toHaveProperty(
      "selectedVariantId",
    );
  });

  it("lists requested axis values even when the current selection is complete", () => {
    const response = buildStorefrontAssistantResponse({
      modelText: "",
      contexts: [context("catalog_product", {
        ucp: { status: "success", version: "2026-04-08" },
        product: product(),
      })],
      payload: payload("What colors does this come in?", {
        kind: "product",
        productId: "prod_khaki",
        selectedVariantId: "var_blue",
        selectedOptions: [
          { name: "Size", label: "43" },
          { name: "Color", label: "Blue" },
        ],
        displayedPrice: 42_000,
        availability: "out_of_stock",
      }),
      origin: ORIGIN,
      searchQuery: "colors come",
    });

    expect(response.text).toContain("Color: Brown, Blue");
    expect(response.text).toContain("selected Size: 43, Color: Blue variant");
  });

  it("does not apply the current page selection to an ordinal product relookup", () => {
    const referencedId = "gid://scalius/product/prod_other";
    const assistant = appendStorefrontAssistantCatalogReferences(
      "Two matches.",
      ["gid://scalius/product/prod_first", referencedId],
      2_000,
    );
    const response = buildStorefrontAssistantResponse({
      modelText: "",
      contexts: [context("catalog_product", {
        ucp: { status: "success", version: "2026-04-08" },
        product: product({
          id: referencedId,
          title: "Other shoes",
          url: `${ORIGIN}/products/other-shoes`,
          variants: [
            {
              id: "gid://scalius/product-variant/other_m",
              price: { amount: 4_104_000, currency: "BDT" },
              options: [{ name: "Size", label: "M" }],
              availability: { available: true, status: "in_stock" },
            },
            {
              id: "gid://scalius/product-variant/other_l",
              price: { amount: 4_200_000, currency: "BDT" },
              options: [{ name: "Size", label: "L" }],
              availability: { available: true, status: "in_stock" },
            },
          ],
        }),
      })],
      payload: {
        messages: [
          { role: "assistant", content: assistant },
          { role: "user", content: "Tell me about the second one" },
        ],
        pageContext: {
          page: { path: "/products/current", kind: "product" },
          surface: {
            kind: "product",
            productId: "prod_current",
            selectedVariantId: "current_m",
            selectedOptions: [{ name: "Size", label: "M" }],
            displayedPrice: 10,
            availability: "in_stock",
          },
        },
      },
      origin: ORIGIN,
      searchQuery: null,
    });

    expect(response.deterministic).toBe(true);
    if (response.parts[1]?.type !== "product_grid") {
      throw new Error("Expected product grid");
    }
    expect(response.parts[1].products[0]).toMatchObject({
      id: referencedId,
      pricePresentation: "starting_at",
    });
    expect(response.parts[1].products[0]).not.toHaveProperty(
      "selectedVariantId",
    );
  });

  it("fails a partial multi-ordinal relookup closed without model guessing", () => {
    const first = "gid://scalius/product/prod_first";
    const third = "gid://scalius/product/prod_removed";
    const assistant = appendStorefrontAssistantCatalogReferences(
      "Three matches.",
      [first, "gid://scalius/product/prod_second", third],
      2_000,
    );
    const response = buildStorefrontAssistantResponse({
      modelText: "The first one is definitely better.",
      contexts: [context("catalog_lookup", {
        ucp: { status: "success", version: "2026-04-08" },
        products: [product({
          id: first,
          title: "First shoes",
          url: `${ORIGIN}/products/first-shoes`,
        })],
      })],
      payload: {
        messages: [
          { role: "assistant", content: assistant },
          { role: "user", content: "Compare first and third" },
        ],
      },
      origin: ORIGIN,
      searchQuery: null,
    });

    expect(response.deterministic).toBe(true);
    expect(response.text).toContain("can’t resolve every referenced item");
    expect(response.text).not.toContain("definitely better");
    expect(response.parts).toHaveLength(1);
  });
});
