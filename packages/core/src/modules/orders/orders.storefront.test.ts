import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { InventoryPool, PaymentMethod } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { createStorefrontOrder } from "./orders.storefront";
import type { CreateStorefrontOrderInput } from "./orders.types";

interface ProductRow {
  id: string;
  name: string;
  isActive: boolean;
  price: number;
  discountPercentage: number | null;
  discountType: string | null;
  discountAmount: number | null;
  freeDelivery: boolean;
}

interface VariantRow {
  id: string;
  productId: string;
  size: string | null;
  color: string | null;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  allowPreorder: boolean;
  allowBackorder: boolean;
  backorderLimit: number;
  isDefault: boolean;
  trackInventory: boolean;
  price: number;
  discountPercentage: number | null;
  discountType: string | null;
  discountAmount: number | null;
}

interface ShippingMethodRow {
  id: string;
  fee: number;
  isActive: boolean;
  deletedAt: Date | null;
}

interface LocationRow {
  id: string;
  name: string;
  type: "city" | "zone" | "area";
  parentId: string | null;
  isActive: boolean;
  deletedAt: Date | null;
}

function createProduct(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "prod_standard",
    name: "Standard Product",
    isActive: true,
    price: 100,
    discountPercentage: null,
    discountType: null,
    discountAmount: null,
    freeDelivery: false,
    ...overrides,
  };
}

function createVariant(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    id: "var_standard",
    productId: "prod_standard",
    size: null,
    color: null,
    stock: 10,
    reservedStock: 0,
    preorderStock: 0,
    allowPreorder: false,
    allowBackorder: false,
    backorderLimit: 0,
    isDefault: false,
    trackInventory: true,
    price: 125,
    discountPercentage: null,
    discountType: null,
    discountAmount: null,
    ...overrides,
  };
}

function createShippingMethod(overrides: Partial<ShippingMethodRow> = {}): ShippingMethodRow {
  return {
    id: "ship_standard",
    fee: 60,
    isActive: true,
    deletedAt: null,
    ...overrides,
  };
}

function createLocation(overrides: Partial<LocationRow> = {}): LocationRow {
  return {
    id: "city_1",
    name: "Dhaka",
    type: "city",
    parentId: null,
    isActive: true,
    deletedAt: null,
    ...overrides,
  };
}

function createOrderInput(overrides: Partial<CreateStorefrontOrderInput> = {}): CreateStorefrontOrderInput {
  return {
    checkoutRequestId: "checkout_req_storefront_test",
    customerName: "Test Customer",
    customerPhone: "+8801700000000",
    customerEmail: "customer@example.com",
    shippingAddress: "123 Test Street",
    city: "city_1",
    zone: "zone_1",
    area: null,
    notes: null,
    items: [
      {
        productId: "prod_standard",
        variantId: "var_standard",
        quantity: 1,
        price: 125,
        productName: "Standard Product",
        variantLabel: null,
      },
    ],
    discountAmount: null,
    discountCode: null,
    shippingCharge: 0,
    shippingMethodId: "ship_standard",
    paymentMethod: PaymentMethod.COD,
    inventoryPool: InventoryPool.REGULAR,
    ...overrides,
  };
}

function createDbMock(readResultBatches: unknown[][], validationProducts: ProductRow[], validationVariants: VariantRow[]): Database {
  const selectResults: unknown[] = [validationProducts, validationVariants];
  const batchResults = [...readResultBatches];
  const statement = {
    where: vi.fn(() => Promise.resolve(selectResults.shift() ?? [])),
    limit: vi.fn(() => ({ statement: "limit" })),
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => statement),
    })),
    batch: vi.fn(async () => batchResults.shift() ?? []),
  } as unknown as Database;
}

async function placeOrder({
  inputOverrides,
  products = [createProduct()],
  variants = [createVariant()],
  locations = [
    createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
    createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
  ],
  shippingMethods = [createShippingMethod()],
}: {
  inputOverrides?: Partial<CreateStorefrontOrderInput>;
  products?: ProductRow[];
  variants?: VariantRow[];
  locations?: LocationRow[];
  shippingMethods?: ShippingMethodRow[];
} = {}) {
  const validationProducts = products.filter((product) => product.isActive === true);
  const db = createDbMock(
    [
      [locations, shippingMethods],
      [[], [], []],
    ],
    validationProducts,
    variants,
  );

  return createStorefrontOrder(
    db,
    createOrderInput(inputOverrides),
    "http://localhost:8787/api/v1/orders",
    vi.fn(async () => null),
    vi.fn(() => 0),
  );
}

describe("createStorefrontOrder product availability verification", () => {
  it("rejects inactive products from stale carts or direct API payloads", async () => {
    await expect(
      placeOrder({
        products: [createProduct({ isActive: false })],
      }),
    ).rejects.toMatchObject({
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          expect.objectContaining({
            code: "PRODUCT_UNAVAILABLE",
            message: "Standard Product is no longer available.",
          }),
        ],
      },
    });
  });

  it("rejects missing products before building an order payload", async () => {
    await expect(
      placeOrder({
        products: [],
      }),
    ).rejects.toMatchObject({
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          expect.objectContaining({
            code: "PRODUCT_UNAVAILABLE",
            message: "Standard Product is no longer available.",
          }),
        ],
      },
    });
  });

  it("rejects a variant that does not belong to the submitted product", async () => {
    await expect(
      placeOrder({
        inputOverrides: {
          items: [
            {
              productId: "prod_standard",
              variantId: "var_foreign",
              quantity: 1,
              price: 125,
              productName: "Standard Product",
              variantLabel: "Foreign Variant",
            },
          ],
        },
        variants: [createVariant({ id: "var_foreign", productId: "prod_other" })],
      }),
    ).rejects.toMatchObject({
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          expect.objectContaining({
            code: "VARIANT_MISMATCH",
            message: "Standard Product has changed. Please remove it and add the option again.",
          }),
        ],
      },
    });
  });

  it("rejects variantless checkout lines for stock-managed products", async () => {
    await expect(
      placeOrder({
        inputOverrides: {
          items: [
            {
              cartKey: "line_variant_required",
              productId: "prod_standard",
              variantId: null,
              quantity: 1,
              price: 100,
              productName: "Standard Product",
              variantLabel: null,
            },
          ],
        },
        variants: [createVariant({ size: "M" })],
      }),
    ).rejects.toMatchObject({
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          expect.objectContaining({
            cartKey: "line_variant_required",
            code: "VARIANT_REQUIRED",
            action: "select_variant",
            message: "Standard Product needs an option selection before checkout.",
          }),
        ],
      },
    });
  });

  it("rejects products without persisted variants as unavailable until product-level inventory exists", async () => {
    await expect(
      placeOrder({
        variants: [],
        inputOverrides: {
          items: [
            {
              cartKey: "line_no_inventory",
              productId: "prod_standard",
              variantId: null,
              quantity: 1,
              price: 100,
              productName: "Standard Product",
              variantLabel: null,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          expect.objectContaining({
            cartKey: "line_no_inventory",
            code: "PRODUCT_UNAVAILABLE",
            action: "remove",
            message: "Standard Product is not available for checkout right now.",
          }),
        ],
      },
    });
  });

  it("accepts variantless simple products by resolving their hidden default SKU", async () => {
    const result = await placeOrder({
      variants: [createVariant({ isDefault: true, trackInventory: false })],
      inputOverrides: {
        items: [
          {
            cartKey: "line_simple",
            productId: "prod_standard",
            variantId: null,
            quantity: 1,
            price: 125,
            productName: "Standard Product",
            variantLabel: null,
          },
        ],
      },
    });

    expect(result.queuePayload.orderData.inventoryAction).toBe("none");
    expect(result.queuePayload.items[0]).toEqual(
      expect.objectContaining({
        variantId: "var_standard",
        inventoryTracked: false,
      }),
    );
  });

  it("rejects stale hidden default SKU carts after a product gains customer options", async () => {
    await expect(
      placeOrder({
        variants: [
          createVariant({ id: "var_default", isDefault: true, trackInventory: false }),
          createVariant({ id: "var_option_m", size: "M", price: 125 }),
        ],
        inputOverrides: {
          items: [
            {
              cartKey: "line_old_simple",
              productId: "prod_standard",
              variantId: "var_default",
              quantity: 1,
              price: 125,
              productName: "Standard Product",
              variantLabel: null,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          expect.objectContaining({
            cartKey: "line_old_simple",
            code: "VARIANT_REQUIRED",
            action: "select_variant",
            message: "Standard Product needs an option selection before checkout.",
          }),
        ],
      },
    });
  });

  it("rejects ambiguous no-option SKU sets that customers cannot select between", async () => {
    await expect(
      placeOrder({
        variants: [
          createVariant({ id: "var_default", isDefault: true, trackInventory: false }),
          createVariant({ id: "var_extra_no_option", price: 125 }),
        ],
        inputOverrides: {
          items: [
            {
              cartKey: "line_ambiguous",
              productId: "prod_standard",
              variantId: null,
              quantity: 1,
              price: 125,
              productName: "Standard Product",
              variantLabel: null,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          expect.objectContaining({
            cartKey: "line_ambiguous",
            code: "PRODUCT_UNAVAILABLE",
            action: "remove",
            message: "Standard Product is not available for checkout right now.",
          }),
        ],
      },
    });
  });

  it("returns all stale-cart item issues with customer-safe messages", async () => {
    try {
      await placeOrder({
        inputOverrides: {
          items: [
            {
              productId: "prod_removed",
              variantId: "var_removed",
              quantity: 1,
              price: 100,
              productName: "Removed Product",
              variantLabel: null,
            },
            {
              productId: "prod_standard",
              variantId: "var_standard",
              quantity: 20,
              price: 125,
              productName: "Standard Product",
              variantLabel: null,
            },
            {
              productId: "prod_price_changed",
              variantId: "var_price_changed",
              quantity: 1,
              price: 50,
              productName: "Price Changed Product",
              variantLabel: null,
            },
          ],
        },
        products: [
          createProduct(),
          createProduct({ id: "prod_price_changed", name: "Price Changed Product", price: 50 }),
        ],
        variants: [
          createVariant(),
          createVariant({ id: "var_price_changed", productId: "prod_price_changed", price: 80 }),
        ],
      });
      throw new Error("Expected stale cart validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details as { itemIssues: Array<{ code: string; message: string; availableQuantity?: number; currentPrice?: number }> };
      expect(details.itemIssues).toEqual([
        expect.objectContaining({
          code: "PRODUCT_UNAVAILABLE",
          message: "Removed Product is no longer available.",
        }),
        expect.objectContaining({
          code: "QUANTITY_UNAVAILABLE",
          message: "Only 10 left for Standard Product.",
          availableQuantity: 10,
        }),
        expect.objectContaining({
          code: "PRICE_CHANGED",
          message: "The price for Price Changed Product changed. Please review the updated cart total.",
          currentPrice: 80,
        }),
      ]);
      expect(details.itemIssues.map((issue) => issue.message).join(" ")).not.toContain("prod_");
      expect(details.itemIssues.map((issue) => issue.message).join(" ")).not.toContain("var_");
    }
  });
});

describe("createStorefrontOrder shipping verification", () => {
  it("derives shipping charge from the selected method instead of caller input", async () => {
    const result = await placeOrder({
      inputOverrides: { shippingCharge: 1 },
      shippingMethods: [createShippingMethod({ fee: 75 })],
    });

    expect(result.queuePayload.orderData.shippingCharge).toBe(75);
    expect(result.totalAmount).toBe(200);
  });

  it("rejects missing or unknown shipping methods when shipping applies", async () => {
    await expect(
      placeOrder({
        inputOverrides: {
          shippingMethodId: null,
          shippingCharge: 0,
        },
        shippingMethods: [],
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      placeOrder({
        inputOverrides: {
          shippingMethodId: "ship_missing",
          shippingCharge: 0,
        },
        shippingMethods: [],
      }),
    ).rejects.toThrow("A valid active shipping method is required for this order.");
  });

  it("rejects inactive or soft-deleted shipping methods", async () => {
    await expect(
      placeOrder({
        shippingMethods: [createShippingMethod({ isActive: false })],
      }),
    ).rejects.toThrow("A valid active shipping method is required for this order.");

    await expect(
      placeOrder({
        shippingMethods: [createShippingMethod({ deletedAt: new Date("2026-01-01T00:00:00.000Z") })],
      }),
    ).rejects.toThrow("A valid active shipping method is required for this order.");
  });

  it("preserves free-delivery item behavior by waiving method requirement and caller charge", async () => {
    const result = await placeOrder({
      inputOverrides: {
        shippingMethodId: null,
        shippingCharge: 999,
      },
      products: [createProduct({ freeDelivery: true })],
      shippingMethods: [],
    });

    expect(result.queuePayload.orderData.shippingCharge).toBe(0);
    expect(result.totalAmount).toBe(125);
  });
});

describe("createStorefrontOrder delivery-location verification", () => {
  it("uses active D1 delivery-location names instead of caller-supplied names", async () => {
    const result = await placeOrder({
      inputOverrides: {
        cityName: "Forged City",
        zoneName: "Forged Zone",
        areaName: "Forged Area",
        area: "area_1",
      },
      locations: [
        createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
        createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
        createLocation({ id: "area_1", name: "Section 10", type: "area", parentId: "zone_1" }),
      ],
    });

    expect(result.queuePayload.orderData.cityName).toBe("Dhaka");
    expect(result.queuePayload.orderData.zoneName).toBe("Mirpur");
    expect(result.queuePayload.orderData.areaName).toBe("Section 10");
  });

  it("rejects unknown, inactive, or soft-deleted city selections", async () => {
    await expect(
      placeOrder({
        locations: [
          createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
        ],
      }),
    ).rejects.toThrow("Selected city is no longer available for checkout.");

    await expect(
      placeOrder({
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null, isActive: false }),
          createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
        ],
      }),
    ).rejects.toThrow("Selected city is no longer available for checkout.");

    await expect(
      placeOrder({
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null, deletedAt: new Date("2026-01-01T00:00:00.000Z") }),
          createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
        ],
      }),
    ).rejects.toThrow("Selected city is no longer available for checkout.");
  });

  it("rejects zones that are missing, wrong-type, inactive, or not children of the city", async () => {
    await expect(
      placeOrder({
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
        ],
      }),
    ).rejects.toThrow("Selected zone is no longer available for the chosen city.");

    await expect(
      placeOrder({
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
          createLocation({ id: "zone_1", name: "Wrong Type", type: "area", parentId: "city_1" }),
        ],
      }),
    ).rejects.toThrow("Selected zone is no longer available for the chosen city.");

    await expect(
      placeOrder({
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
          createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_2" }),
        ],
      }),
    ).rejects.toThrow("Selected zone is no longer available for the chosen city.");

    await expect(
      placeOrder({
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
          createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1", isActive: false }),
        ],
      }),
    ).rejects.toThrow("Selected zone is no longer available for the chosen city.");
  });

  it("rejects areas that are missing, wrong-type, inactive, or not children of the zone", async () => {
    await expect(
      placeOrder({
        inputOverrides: { area: "area_1" },
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
          createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
        ],
      }),
    ).rejects.toThrow("Selected area is no longer available for the chosen zone.");

    await expect(
      placeOrder({
        inputOverrides: { area: "area_1" },
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
          createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
          createLocation({ id: "area_1", name: "Wrong Type", type: "zone", parentId: "zone_1" }),
        ],
      }),
    ).rejects.toThrow("Selected area is no longer available for the chosen zone.");

    await expect(
      placeOrder({
        inputOverrides: { area: "area_1" },
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
          createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
          createLocation({ id: "area_1", name: "Section 10", type: "area", parentId: "zone_2" }),
        ],
      }),
    ).rejects.toThrow("Selected area is no longer available for the chosen zone.");

    await expect(
      placeOrder({
        inputOverrides: { area: "area_1" },
        locations: [
          createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
          createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
          createLocation({ id: "area_1", name: "Section 10", type: "area", parentId: "zone_1", isActive: false }),
        ],
      }),
    ).rejects.toThrow("Selected area is no longer available for the chosen zone.");
  });
});
