import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProductBySlug: vi.fn(),
  getLayoutData: vi.fn(),
  validateCartItems: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getProductBySlug: mocks.getProductBySlug,
}));

vi.mock("@/lib/api/storefront", () => ({
  getLayoutData: mocks.getLayoutData,
}));

vi.mock("@/lib/api/runtime", () => ({
  setRuntimeImageCdnPolicy: vi.fn(),
}));

vi.mock("@/lib/api/orders", () => ({
  validateCartItems: mocks.validateCartItems,
}));

vi.mock("@/lib/product-media", () => ({
  getProductImageUrl: (url: string) => url,
  hasProductImage: (url: string | null | undefined) => Boolean(url),
}));

vi.mock("@/lib/safe-json", () => ({
  serializeJsonForInlineScript: (value: unknown) => JSON.stringify(value),
}));

vi.mock("@/lib/product-sellable-variants", async () => (
  await import("../../product-sellable-variants")
));

import { GET, POST } from "../../../pages/buy/[slug]";

function validCartValidation(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      valid: true,
      issues: [],
      items: [
        {
          index: 0,
          cartKey: "quick_buy:prod_1:var_default_prod_1",
          productId: "prod_1",
          variantId: "var_default_prod_1",
          quantity: 1,
          unitPrice: 150,
          productName: "Cotton Panjabi",
          variantLabel: null,
          freeDelivery: false,
          availableQuantity: null,
          productImageMediaId: "med_validated_image",
          productImage: "https://media.example.test/validated.webp",
          ...overrides,
        },
      ],
      subtotal: 150,
      hasFreeDeliveryProduct: false,
    },
  };
}

function simpleDefaultVariant() {
  return {
    id: "var_default_prod_1",
    productId: "prod_1",
    price: 150,
    isDefault: true,
    optionCombinationKey: null,
    selectedOptions: [],
    deletedAt: null,
  };
}

function extractQuickBuyData(html: string) {
  const match = html.match(/const quickBuyData = (.*?);\s+try/s);
  expect(match).not.toBeNull();
  return JSON.parse(JSON.parse(match?.[1] ?? "\"{}\"")) as {
    cartItem?: {
      options?: Array<{ name: string; label: string }>;
      image?: string;
      imageMediaId?: string;
    };
  };
}

describe("/buy/[slug]", () => {
  beforeEach(() => {
    mocks.getProductBySlug.mockReset();
    mocks.getLayoutData.mockReset();
    mocks.getLayoutData.mockResolvedValue(undefined);
    mocks.validateCartItems.mockReset();
    mocks.validateCartItems.mockResolvedValue(validCartValidation());
  });

  it("does not create quick-buy cart data for products without real variants", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "cotton-panjabi",
        name: "Cotton Panjabi",
        discountedPrice: 150,
        price: 150,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: false,
        imageUrl: null,
      },
      images: [],
      variants: [{ id: "default", productId: "prod_1", price: 150 }],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=product_unavailable");
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("creates quick-buy cart data for simple products with a hidden default SKU", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "cotton-panjabi",
        name: "Cotton Panjabi",
        discountedPrice: 150,
        price: 150,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [simpleDefaultVariant()],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);
    const html = await response.text();
    const quickBuyData = extractQuickBuyData(html);

    expect(response.status).toBe(200);
    expect(html).toContain("var_default_prod_1");
    expect(html).toContain("sessionStorage.getItem('quickBuyData')");
    expect(html).toContain("/cart?quickBuyStorage=blocked");
    expect(quickBuyData.cartItem).toMatchObject({
      image: "https://media.example.test/validated.webp",
      imageMediaId: "med_validated_image",
    });
    expect(mocks.validateCartItems).toHaveBeenCalledWith([
      expect.objectContaining({
        cartKey: "quick_buy:prod_1:var_default_prod_1",
        productId: "prod_1",
        variantId: "var_default_prod_1",
        quantity: 1,
        price: 150,
        productName: "Cotton Panjabi",
        variantLabel: null,
      }),
    ]);
  });

  it("requires an explicit variant for optioned products", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "cotton-panjabi",
        name: "Cotton Panjabi",
        discountedPrice: 150,
        price: 150,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [{
        id: "var_m",
        productId: "prod_1",
        price: 150,
        isDefault: false,
        optionCombinationKey: "fit:m",
        selectedOptions: [{ name: "Fit", value: "M" }],
      }],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=variant_required");
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("does not accept a hidden default SKU after customer options exist", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "cotton-panjabi",
        name: "Cotton Panjabi",
        discountedPrice: 150,
        price: 150,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [
        {
          id: "var_default_prod_1",
          productId: "prod_1",
          price: 150,
          isDefault: true,
          optionCombinationKey: null,
          selectedOptions: [],
        },
        {
          id: "var_m",
          productId: "prod_1",
          price: 150,
          isDefault: false,
          optionCombinationKey: "fit:m",
          selectedOptions: [{ name: "Fit", value: "M" }],
        },
      ],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi?variant=var_default_prod_1"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=variant_not_found");
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("stores merchant option labels in quick-buy cart data", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "premium-rice",
        name: "Premium Rice",
        discountedPrice: 850,
        price: 850,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [{
        id: "var_2kg_gift",
        productId: "prod_1",
        price: 850,
        isDefault: false,
        optionCombinationKey: "weight:2kg|style:gift-box|packaging:tin",
        selectedOptions: [
          { name: "Weight", value: "2KG" },
          { name: "Style", value: "Gift Box" },
          { name: "Packaging", value: "Reusable tin" },
        ],
        deletedAt: null,
      }],
      category: null,
    });
    mocks.validateCartItems.mockResolvedValueOnce(
      validCartValidation({
        cartKey: "quick_buy:prod_1:var_2kg_gift",
        variantId: "var_2kg_gift",
        quantity: 2,
        unitPrice: 850,
        productName: "Premium Rice",
      }),
    );

    const response = await GET({
      params: { slug: "premium-rice" },
      url: new URL("https://storefront.example.test/buy/premium-rice?variant=var_2kg_gift&qty=2"),
    } as never);
    const html = await response.text();
    const quickBuyData = extractQuickBuyData(html);

    expect(response.status).toBe(200);
    expect(quickBuyData.cartItem).toMatchObject({
      options: [
        { name: "Weight", label: "2KG" },
        { name: "Style", label: "Gift Box" },
        { name: "Packaging", label: "Reusable tin" },
      ],
    });
  });

  it("uses the shared precision-aware pricing authority for quick buy", async () => {
    mocks.getLayoutData.mockResolvedValueOnce({
      currency: { code: "KWD", symbol: "KD", usdExchangeRate: 1, decimalPlaces: 3 },
    });
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "precision-lamp",
        name: "Precision Lamp",
        discountedPrice: 1.005,
        price: 1.005,
        discountType: "percentage",
        discountAmount: null,
        discountPercentage: 10,
        freeDelivery: false,
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [{
        ...simpleDefaultVariant(),
        price: 1.005,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
      }],
      category: null,
    });
    mocks.validateCartItems.mockResolvedValueOnce(
      validCartValidation({ unitPrice: 0.905 }),
    );

    const response = await GET({
      params: { slug: "precision-lamp" },
      url: new URL("https://storefront.example.test/buy/precision-lamp"),
    } as never);

    expect(response.status).toBe(200);
    expect(mocks.validateCartItems).toHaveBeenCalledWith([
      expect.objectContaining({ price: 0.905 }),
    ]);
  });

  it("does not create quick-buy cart data when validation reports out of stock", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "cotton-panjabi",
        name: "Cotton Panjabi",
        discountedPrice: 150,
        price: 150,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [simpleDefaultVariant()],
      category: null,
    });
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: false,
        issues: [{
          index: 0,
          productId: "prod_1",
          variantId: "var_default_prod_1",
          code: "QUANTITY_UNAVAILABLE",
          action: "remove",
          message: "Cotton Panjabi is out of stock.",
          productName: "Cotton Panjabi",
          variantLabel: null,
          requestedQuantity: 1,
          availableQuantity: 0,
        }],
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=out_of_stock");
  });

  it("rejects invalid quick-buy quantities before cart validation", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "cotton-panjabi",
        name: "Cotton Panjabi",
        discountedPrice: 150,
        price: 150,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [simpleDefaultVariant()],
      category: null,
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi?qty=1000"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=invalid_quantity");
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("does not create quick-buy cart data when validation reports a price change", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "cotton-panjabi",
        name: "Cotton Panjabi",
        discountedPrice: 150,
        price: 150,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [simpleDefaultVariant()],
      category: null,
    });
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: false,
        issues: [{
          index: 0,
          productId: "prod_1",
          variantId: "var_default_prod_1",
          code: "PRICE_CHANGED",
          action: "refresh_item",
          message: "Cotton Panjabi price changed.",
          productName: "Cotton Panjabi",
          variantLabel: null,
          requestedQuantity: 1,
          submittedPrice: 150,
          currentPrice: 175,
        }],
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=price_changed");
  });

  it("fails closed when quick-buy validation is temporarily unavailable", async () => {
    mocks.getProductBySlug.mockResolvedValueOnce({
      product: {
        id: "prod_1",
        slug: "cotton-panjabi",
        name: "Cotton Panjabi",
        discountedPrice: 150,
        price: 150,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        freeDelivery: false,
        hasVariants: true,
        imageUrl: null,
      },
      images: [],
      variants: [simpleDefaultVariant()],
      category: null,
    });
    mocks.validateCartItems.mockResolvedValueOnce({
      success: false,
      status: 503,
      error: "Cart validation failed",
    });

    const response = await GET({
      params: { slug: "cotton-panjabi" },
      url: new URL("https://storefront.example.test/buy/cotton-panjabi"),
    } as never);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/products/cotton-panjabi?error=validation_unavailable");
  });

  describe("buyer inputs", () => {
    function customizedProduct(overrides: Record<string, unknown> = {}) {
      return {
        product: {
          id: "prod_1",
          slug: "engraved-pen",
          name: "Engraved Pen",
          discountedPrice: 1200,
          price: 1200,
          discountType: null,
          discountAmount: null,
          discountPercentage: null,
          freeDelivery: false,
          hasVariants: true,
          imageUrl: null,
          customization: {
            fields: [
              { key: "engraving", label: "Engraving text", type: "text", required: false, help: null, maxLength: 20, price: 200, priceMinor: 20_000, options: [] },
              {
                key: "fit", label: "Fit", type: "select", required: true, help: null, maxLength: null, price: 0, priceMinor: 0,
                options: [
                  { value: "regular", label: "Regular", price: 0, priceMinor: 0 },
                  { value: "slim", label: "Slim", price: 100, priceMinor: 10_000 },
                ],
              },
            ],
          },
          requiresCustomization: true,
          customizationUnavailable: false,
          ...overrides,
        },
        images: [],
        variants: [{ ...simpleDefaultVariant(), price: 1200, fulfillmentKind: "physical" }],
        category: null,
      };
    }

    function formRequest(fields: Array<[string, string]>, headers: Record<string, string> = {}) {
      return new Request("https://storefront.example.test/buy/engraved-pen", {
        method: "POST",
        headers,
        body: new URLSearchParams(fields),
      });
    }

    function post(request: Request) {
      return POST({ params: { slug: "engraved-pen" }, request } as never);
    }

    it("sends quick-buy links for products with required inputs to the product page", async () => {
      mocks.getProductBySlug.mockResolvedValueOnce(customizedProduct());

      const response = await GET({
        params: { slug: "engraved-pen" },
        url: new URL("https://storefront.example.test/buy/engraved-pen"),
      } as never);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toBe("/products/engraved-pen?error=customization_required");
      expect(mocks.validateCartItems).not.toHaveBeenCalled();
    });

    it("refuses products whose buyer-input setup can't be read", async () => {
      mocks.getProductBySlug.mockResolvedValueOnce(
        customizedProduct({ customization: null, requiresCustomization: false, customizationUnavailable: true }),
      );

      const response = await GET({
        params: { slug: "engraved-pen" },
        url: new URL("https://storefront.example.test/buy/engraved-pen"),
      } as never);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toBe("/products/engraved-pen?error=customization_unavailable");
      expect(mocks.validateCartItems).not.toHaveBeenCalled();
    });

    it("prices the posted inputs and puts the server's resolved inputs on the cart line", async () => {
      mocks.getProductBySlug.mockResolvedValueOnce(customizedProduct());
      mocks.validateCartItems.mockResolvedValueOnce(validCartValidation({
        cartKey: "quick_buy:prod_1:var_default_prod_1",
        quantity: 2,
        unitPrice: 1500,
        baseUnitPrice: 1200,
        propertiesPriceMinor: 30_000,
        productName: "Engraved Pen",
        fulfillmentKind: "physical",
        properties: [
          { key: "engraving", type: "text", label: "Engraving text", value: "Anika", displayValue: "Anika", price: 200, priceMinor: 20_000 },
          { key: "fit", type: "select", label: "Fit", value: "slim", displayValue: "Slim", price: 100, priceMinor: 10_000 },
        ],
      }));

      const response = await post(formRequest([
        ["variant", "var_default_prod_1"],
        ["quantity", "2"],
        ["property.fit", "slim"],
        ["property.engraving", "  Anika "],
      ]));
      const html = await response.text();
      const quickBuyData = extractQuickBuyData(html) as {
        cartItem?: Record<string, unknown>;
        addToCartEvent?: unknown;
        initiateCheckoutEvent?: unknown;
      };

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mocks.validateCartItems).toHaveBeenCalledWith([
        expect.objectContaining({
          variantId: "var_default_prod_1",
          quantity: 2,
          price: 1500,
          properties: [
            { key: "engraving", value: "Anika" },
            { key: "fit", value: "slim" },
          ],
        }),
      ]);
      expect(quickBuyData.cartItem).toMatchObject({
        price: 1500,
        quantity: 2,
        variantId: "var_default_prod_1",
        fulfillmentKind: "physical",
        properties: [
          { key: "engraving", value: "Anika", label: "Engraving text", displayValue: "Anika", priceMinor: 20_000 },
          { key: "fit", value: "slim", label: "Fit", displayValue: "Slim", priceMinor: 10_000 },
        ],
      });
      // Analytics carry the SKU, quantity and price only, never buyer inputs.
      expect(JSON.stringify(quickBuyData.addToCartEvent)).not.toContain("Anika");
      expect(JSON.stringify(quickBuyData.initiateCheckoutEvent)).not.toMatch(/Anika|properties|slim/);
    });

    it("sends a missing required input back to the product page without any value in the URL", async () => {
      mocks.getProductBySlug.mockResolvedValueOnce(customizedProduct());

      const response = await post(formRequest([
        ["variant", "var_default_prod_1"],
        ["quantity", "1"],
        ["property.engraving", "Secret Name"],
        ["property.fit", ""],
      ]));

      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe("/products/engraved-pen?error=customization_required");
      expect(response.headers.get("Location")).not.toContain("Secret");
      expect(mocks.validateCartItems).not.toHaveBeenCalled();
    });

    it("maps a server input issue to a notice code", async () => {
      mocks.getProductBySlug.mockResolvedValueOnce(customizedProduct());
      mocks.validateCartItems.mockResolvedValueOnce({
        success: true,
        data: {
          valid: false,
          issues: [{
            index: 0,
            productId: "prod_1",
            variantId: "var_default_prod_1",
            code: "PROPERTIES_INVALID",
            action: "edit_properties",
            message: "Fit is not one of the choices.",
            productName: "Engraved Pen",
            variantLabel: null,
            requestedQuantity: 1,
            propertyKey: "fit",
          }],
          items: [],
          subtotal: 0,
          hasFreeDeliveryProduct: false,
        },
      });

      const response = await post(formRequest([
        ["variant", "var_default_prod_1"],
        ["property.engraving", "Secret Name"],
        ["property.fit", "slim"],
      ]));

      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe("/products/engraved-pen?error=customization_invalid");
    });

    it("refuses cross-origin form posts that carry cookies", async () => {
      // The test DOM's Request drops Cookie (a forbidden header), so the
      // guard reads a plain request with the same method, URL and headers.
      const response = await post({
        method: "POST",
        url: "https://storefront.example.test/buy/engraved-pen",
        headers: new Headers({
          Cookie: "session=1",
          Origin: "https://evil.example.test",
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      } as Request);

      expect(response.status).toBe(403);
      expect(mocks.getProductBySlug).not.toHaveBeenCalled();
    });

    it("refuses bodies that are not the product form", async () => {
      const response = await post(new Request("https://storefront.example.test/buy/engraved-pen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: [{ key: "fit", value: "slim" }] }),
      }));

      expect(response.status).toBe(415);
      expect(mocks.getProductBySlug).not.toHaveBeenCalled();
    });
  });
});
