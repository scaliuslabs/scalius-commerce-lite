import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { InventoryPool, PaymentMethod } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import {
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  validateStorefrontDeliveryPreflight,
} from "./orders.storefront";
import { validateStorefrontCartItems } from "./cart-validation";
import { calculateStorefrontTaxQuote } from "../tax";
import type { CreateStorefrontOrderCustomerIdentity, CreateStorefrontOrderInput } from "./orders.types";

const mediaMocks = vi.hoisted(() => ({
  loadProductMediaProjections: vi.fn(async () => new Map()),
}));

vi.mock("../products/products.media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../products/products.media")>()),
  loadProductMediaProjections: mediaMocks.loadProductMediaProjections,
}));

const discountMocks = vi.hoisted(() => ({
  quoteStorefrontDiscount: vi.fn(async (): Promise<unknown> => ({
    applied: null,
    snapshot: null,
    taxAllocation: undefined,
  })),
}));

vi.mock("../promotions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../promotions")>()),
  quoteStorefrontDiscount: discountMocks.quoteStorefrontDiscount,
}));

vi.mock("../tax", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tax")>();
  return {
    ...actual,
    calculateStorefrontTaxQuote: vi.fn(async (
      _db: Database,
      input: import("../tax").StorefrontTaxQuoteInput,
    ) => {
      const lines = input.lines.map((line) => {
        const unitPriceMinor = line.unitPriceMinor;
        const grossAmountMinor = unitPriceMinor * line.quantity;
        return {
          lineId: line.lineId,
          productId: line.productId,
          variantId: line.variantId,
          taxClassId: null,
          taxClassName: null,
          unitPriceMinor,
          quantity: line.quantity,
          grossAmountMinor,
          discountMinor: 0,
          taxableAmountMinor: 0,
          taxMinor: 0,
          totalMinor: grossAmountMinor,
          components: [],
        };
      });
      const subtotalMinor = lines.reduce((sum: number, line) => sum + line.grossAmountMinor, 0);
      const shippingMinor = input.shippingMinor;
      const allocation = input.promotionDiscountAllocation;
      const discountMinor = allocation
        ? allocation.lines.reduce((sum, line) => sum + line.amountMinor, allocation.shippingMinor)
        : 0;
      return {
        schemaVersion: 1 as const,
        calculationVersion: "tax-v1" as const,
        enabled: false,
        currencyCode: "BDT",
        decimalPlaces: 2,
        displayLabel: "Tax",
        pricesIncludeTax: false,
        shippingTaxed: false,
        settingsVersion: 0,
        subtotalMinor,
        shippingMinor,
        discountMinor,
        taxableMinor: 0,
        taxMinor: 0,
        totalMinor: subtotalMinor + shippingMinor - discountMinor,
        destination: input.destination,
        lines,
        shipping: {
          taxClassId: null,
          taxClassName: null,
          grossAmountMinor: shippingMinor,
          discountMinor: 0,
          taxableAmountMinor: 0,
          taxMinor: 0,
          totalMinor: shippingMinor,
          components: [],
        },
      };
    }),
  };
});

interface ProductRow {
  id: string;
  name: string;
  isActive: boolean;
  priceMinor: number;
  discountBps: number;
  discountType: string | null;
  discountAmountMinor: number;
  freeDelivery: boolean;
  taxClassId: string | null;
}

interface VariantRow {
  id: string;
  productId: string;
  optionCombinationKey: string | null;
  optionLabel: string | null;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  allowPreorder: boolean;
  allowBackorder: boolean;
  backorderLimit: number;
  isDefault: boolean;
  trackInventory: boolean;
  priceMinor: number;
  discountBps: number;
  discountType: string | null;
  discountAmountMinor: number;
  taxClassId: string | null;
  imageId: string | null;
}

interface ShippingMethodRow {
  id: string;
  name: string;
  description: string | null;
  feeMinor: number;
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
    priceMinor: 10_000,
    discountBps: 0,
    discountType: null,
    discountAmountMinor: 0,
    freeDelivery: false,
    taxClassId: null,
    ...overrides,
  };
}

function createVariant(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    id: "var_standard",
    productId: "prod_standard",
    optionCombinationKey: null,
    optionLabel: null,
    stock: 10,
    reservedStock: 0,
    preorderStock: 0,
    allowPreorder: false,
    allowBackorder: false,
    backorderLimit: 0,
    isDefault: true,
    trackInventory: true,
    priceMinor: 12_500,
    discountBps: 0,
    discountType: null,
    discountAmountMinor: 0,
    taxClassId: null,
    imageId: null,
    ...overrides,
  };
}

function createShippingMethod(overrides: Partial<ShippingMethodRow> = {}): ShippingMethodRow {
  return {
    id: "ship_standard",
    name: "Standard delivery",
    description: "Delivered within 2–3 business days",
    feeMinor: 6_000,
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
    expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
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

it("rejects unbounded storefront carts before database reads", async () => {
  const db = { select: vi.fn(), batch: vi.fn() } as unknown as Database;
  const item = createOrderInput().items[0]!;

  await expect(createStorefrontOrder(
    db,
    createOrderInput({
      items: Array.from({ length: 100 }, (_, index) => ({
        ...item,
        productId: `product_${index}`,
        variantId: `variant_${index}`,
      })),
    }),
    "https://shop.example.com/api/v1/orders",
  )).rejects.toThrow("at most 99 line items");
  expect(db.select).not.toHaveBeenCalled();
  expect(db.batch).not.toHaveBeenCalled();
});

async function placeOrder({
  inputOverrides,
  customerIdentity,
  products = [createProduct()],
  variants = [createVariant()],
  locations = [
    createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
    createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
  ],
  shippingMethods = [createShippingMethod()],
}: {
  inputOverrides?: Partial<CreateStorefrontOrderInput>;
  customerIdentity?: CreateStorefrontOrderCustomerIdentity;
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
    undefined,
    undefined,
    undefined,
    customerIdentity,
  );
}

describe("createStorefrontOrder tax discount parity", () => {
  it("keeps random order-item keys separate from the stable quote allocation identity", async () => {
    vi.mocked(calculateStorefrontTaxQuote).mockClear();
    const result = await placeOrder();
    const taxInput = vi.mocked(calculateStorefrontTaxQuote).mock.calls[0]?.[1];

    expect(taxInput?.lines[0]?.lineId).toBe("cart:0:var_standard");
    expect(result.commitPayload.items[0]).toMatchObject({
      taxAllocationLineId: "cart:0:var_standard",
    });
    expect(result.commitPayload.items[0]?.id).toMatch(/^item_/);
    expect(result.commitPayload.items[0]?.id).not.toBe("cart:0:var_standard");
  });

  it("carries typed promotion allocations into the exact tax and commit snapshots", async () => {
    vi.mocked(calculateStorefrontTaxQuote).mockClear();
    const applied = {
      promotionId: "promo_1",
      promotionRevision: 2,
      promotionName: "Order and delivery savings",
      method: "code" as const,
      promotionCode: "SAVE15",
      totalDiscountMinor: 1500,
      allocations: [
        {
          promotionId: "promo_1",
          promotionRevision: 2,
          evaluatorVersion: 1,
          promotionName: "Order and delivery savings",
          promotionCode: "SAVE15",
          method: "code" as const,
          effectId: "effect_order",
          effectKind: "fixed_amount_off" as const,
          target: "order" as const,
          lineId: "cart:0:var_standard",
          quantity: 1,
          currencyCode: "BDT",
          baseAmountMinor: 12500,
          discountAmountMinor: 1000,
        },
        {
          promotionId: "promo_1",
          promotionRevision: 2,
          evaluatorVersion: 1,
          promotionName: "Order and delivery savings",
          promotionCode: "SAVE15",
          method: "code" as const,
          effectId: "effect_shipping",
          effectKind: "fixed_amount_off" as const,
          target: "shipping" as const,
          lineId: null,
          quantity: null,
          currencyCode: "BDT",
          baseAmountMinor: 6000,
          discountAmountMinor: 500,
        },
      ],
    };
    const taxAllocation = {
      lines: [{ lineId: "cart:0:var_standard", amountMinor: 1000 }],
      shippingMinor: 500,
    };
    discountMocks.quoteStorefrontDiscount.mockResolvedValueOnce({
      applied,
      snapshot: { cart: {}, applied },
      taxAllocation,
    });
    const result = await placeOrder({
      inputOverrides: { discountCode: "SAVE15", discountAmount: 9_999 },
      customerIdentity: { customerId: "customer_session_owner", source: "authenticated" },
    });
    expect(discountMocks.quoteStorefrontDiscount).toHaveBeenLastCalledWith(expect.anything(), {
      code: "SAVE15",
      customerId: "customer_session_owner",
      customerPhone: "+8801700000000",
      cart: {
        currencyCode: "BDT",
        lines: [{
          id: "cart:0:var_standard",
          productId: "prod_standard",
          variantId: "var_standard",
          unitPriceMinor: 12_500,
          quantity: 1,
        }],
        shippingAmountMinor: 6_000,
      },
    });
    const taxInput = vi.mocked(calculateStorefrontTaxQuote).mock.calls.at(-1)?.[1];
    expect(taxInput?.promotionDiscountAllocation).toEqual(taxAllocation);
    expect(taxInput?.discountMinor).toBeUndefined();
    expect(result.commitPayload).toMatchObject({
      promotion: { applied: { promotionId: "promo_1", totalDiscountMinor: 1500 } },
    });
  });

  it("fails closed with the buyer-facing reason when the code does not apply", async () => {
    discountMocks.quoteStorefrontDiscount.mockRejectedValueOnce(
      new ValidationError("Your cart does not meet this discount's minimum subtotal."),
    );
    await expect(placeOrder({ inputOverrides: { discountCode: "SAVE20" } }))
      .rejects.toThrow("minimum subtotal");
  });

  it("snapshots the actual resolved image asset in the checkout commit payload", async () => {
    mediaMocks.loadProductMediaProjections.mockResolvedValueOnce(new Map([[
      "prod_standard",
      [{
        id: "pmed_exact",
        mediaId: "med_exact_image",
        kind: "image",
        url: "https://media.example.test/exact.webp",
        posterMediaId: null,
        posterUrl: null,
        altText: "Exact SKU image",
        caption: null,
        width: 800,
        height: 800,
        durationMs: null,
        isPrimary: true,
        sortOrder: 0,
        status: "ready",
      }],
    ]]));

    const result = await placeOrder({
      variants: [createVariant({ imageId: "pmed_exact" })],
    });

    expect(result.commitPayload.items[0]).toEqual(expect.objectContaining({
      productImageMediaId: "med_exact_image",
    }));
  });

});

describe("createStorefrontOrder product availability verification", () => {
  it("keeps true guest checkout orders detached from customer accounts", async () => {
    const result = await placeOrder();

    expect(result.commitPayload.existingCustomer).toBeNull();
  });

  it("binds storefront order payloads only to explicit authenticated customer identity", async () => {
    const result = await placeOrder({
      customerIdentity: {
        customerId: "customer_session_owner",
        source: "authenticated",
      },
    });

    expect(result.commitPayload.existingCustomer).toEqual({ id: "customer_session_owner" });
  });

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

  it.each([undefined, null, "", "default"])(
    "rejects a non-persisted variant id (%s) before querying D1",
    async (variantId) => {
      const select = vi.fn();
      const result = await validateStorefrontCartItems(
        { select } as unknown as Database,
        [{
          cartKey: "line_variant_required",
          productId: "prod_standard",
          variantId,
          quantity: 1,
          price: 100,
          productName: "Standard Product",
          variantLabel: null,
        }] as unknown as Parameters<typeof validateStorefrontCartItems>[1],
      );

      expect(select).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        valid: false,
        items: [],
        issues: [expect.objectContaining({
          cartKey: "line_variant_required",
          variantId: null,
          code: "VARIANT_REQUIRED",
          action: "select_variant",
          message: "Standard Product needs a saved option selection before checkout.",
        })],
      });
    },
  );

  it.each([
    {
      currencyCode: "JPY",
      storedPriceMinor: 100,
      submittedPrice: 100,
      quantity: 3,
      expectedSubtotalMinor: 300,
    },
    {
      currencyCode: "KWD",
      storedPriceMinor: 1_235,
      submittedPrice: 1.235,
      quantity: 3,
      expectedSubtotalMinor: 3_705,
    },
  ])(
    "compares submitted $currencyCode prices to stored minor units at ISO precision",
    async ({
      currencyCode,
      storedPriceMinor,
      submittedPrice,
      quantity,
      expectedSubtotalMinor,
    }) => {
      const db = createDbMock(
        [],
        [createProduct({ priceMinor: storedPriceMinor })],
        [createVariant({ priceMinor: storedPriceMinor, trackInventory: false })],
      );

      const result = await validateStorefrontCartItems(
        db,
        [{
          productId: "prod_standard",
          variantId: "var_standard",
          quantity,
          price: submittedPrice,
          productName: "Standard Product",
          variantLabel: null,
        }],
        { currencyCode },
      );

      expect(result).toMatchObject({
        valid: true,
        issues: [],
        subtotalMinor: expectedSubtotalMinor,
        items: [expect.objectContaining({
          unitPriceMinor: storedPriceMinor,
          quantity,
        })],
      });
    },
  );

  it("uses an explicit BDT fallback for direct Core cart validation", async () => {
    const db = createDbMock(
      [],
      [createProduct({ priceMinor: 123 })],
      [createVariant({ priceMinor: 123, trackInventory: false })],
    );

    const result = await validateStorefrontCartItems(db, [{
      productId: "prod_standard",
      variantId: "var_standard",
      quantity: 2,
      price: 1.23,
      productName: "Standard Product",
      variantLabel: null,
    }]);

    expect(result).toMatchObject({
      valid: true,
      subtotalMinor: 246,
      items: [expect.objectContaining({ unitPriceMinor: 123 })],
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
              variantId: "var_missing",
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
            code: "VARIANT_UNAVAILABLE",
            action: "remove",
            message: "Standard Product is no longer available.",
          }),
        ],
      },
    });
  });

  it("rejects a deleted submitted SKU even when the product still has a valid simple SKU", async () => {
    await expect(placeOrder({
      variants: [createVariant({ id: "var_current" })],
      inputOverrides: {
        items: [{
          cartKey: "line_deleted_sku",
          productId: "prod_standard",
          variantId: "var_deleted",
          quantity: 1,
          price: 125,
          productName: "Standard Product",
          variantLabel: null,
        }],
      },
    })).rejects.toMatchObject({
      details: {
        itemIssues: [expect.objectContaining({
          cartKey: "line_deleted_sku",
          variantId: "var_deleted",
          code: "VARIANT_UNAVAILABLE",
          action: "remove",
        })],
      },
    });
  });

  it("accepts a simple product only when its persisted hidden default SKU is submitted", async () => {
    const result = await placeOrder({
      variants: [createVariant({ isDefault: true, trackInventory: false })],
      inputOverrides: {
        items: [
          {
            cartKey: "line_simple",
            productId: "prod_standard",
            variantId: "var_standard",
            quantity: 1,
            price: 125,
            productName: "Standard Product",
            variantLabel: null,
          },
        ],
      },
    });

    expect(result.commitPayload.orderData.inventoryAction).toBe("none");
    expect(result.commitPayload.items[0]).toEqual(
      expect.objectContaining({
        variantId: "var_standard",
        inventoryTracked: false,
      }),
    );
  });

  it("never exposes an option label for the protected simple SKU", async () => {
    const result = await placeOrder({
      variants: [createVariant({
        isDefault: true,
        optionCombinationKey: null,
        optionLabel: "Ignored default label",
        trackInventory: false,
      })],
      inputOverrides: {
        items: [
          {
            cartKey: "line_simple_default",
            productId: "prod_standard",
            variantId: "var_standard",
            quantity: 1,
            price: 125,
            productName: "Standard Product",
            variantLabel: "Ignored default label",
          },
        ],
      },
    });

    expect(result.commitPayload.items[0]).toEqual(
      expect.objectContaining({
        variantId: "var_standard",
        variantLabel: null,
        inventoryTracked: false,
      }),
    );
  });

  it("accepts an explicitly submitted buyer option SKU", async () => {
    const result = await placeOrder({
      variants: [
        createVariant({ id: "var_default", isDefault: true, trackInventory: false }),
        createVariant({
          id: "var_option_m",
          optionCombinationKey: "value_m",
          optionLabel: "M",
          isDefault: false,
        }),
      ],
      inputOverrides: {
        items: [{
          cartKey: "line_option_m",
          productId: "prod_standard",
          variantId: "var_option_m",
          quantity: 1,
          price: 125,
          productName: "Standard Product",
          variantLabel: "M",
        }],
      },
    });

    expect(result.commitPayload.items[0]).toEqual(expect.objectContaining({
      variantId: "var_option_m",
      variantLabel: "M",
      inventoryTracked: true,
    }));
  });

  it("rejects checkout when an active option SKU lacks combination identity", async () => {
    await expect(
      placeOrder({
        variants: [
          createVariant({
            id: "var_size_42",
            optionCombinationKey: "value_42",
            optionLabel: "42",
            isDefault: false,
          }),
          createVariant({
            id: "var_size_41_green",
            optionCombinationKey: null,
            optionLabel: "41 / Green",
            isDefault: false,
          }),
        ],
        inputOverrides: {
          items: [
            {
              cartKey: "line_mixed_axes",
              productId: "prod_standard",
              variantId: "var_size_42",
              quantity: 1,
              price: 125,
              productName: "Standard Product",
              variantLabel: "42",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          expect.objectContaining({
            cartKey: "line_mixed_axes",
            code: "PRODUCT_UNAVAILABLE",
            action: "remove",
            message: "Standard Product is not available for checkout right now.",
          }),
        ],
      },
    });
  });

  it("rejects a sole no-option SKU when it is not the protected default SKU", async () => {
    await expect(
      placeOrder({
        variants: [createVariant({ id: "var_bad_no_option", isDefault: false, trackInventory: false })],
        inputOverrides: {
          items: [
            {
              cartKey: "line_bad_no_option",
              productId: "prod_standard",
              variantId: "var_bad_no_option",
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
            cartKey: "line_bad_no_option",
            code: "PRODUCT_UNAVAILABLE",
            action: "remove",
            message: "Standard Product is not available for checkout right now.",
          }),
        ],
      },
    });
  });

  it("rejects stale hidden default SKU carts after a product gains customer options", async () => {
    await expect(
      placeOrder({
        variants: [
          createVariant({ id: "var_default", isDefault: true, trackInventory: false }),
          createVariant({
            id: "var_option_m",
            optionCombinationKey: "value_m",
            optionLabel: "M",
            isDefault: false,
            priceMinor: 12_500,
          }),
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
          createVariant({ id: "var_extra_no_option", isDefault: false, priceMinor: 12_500 }),
        ],
        inputOverrides: {
          items: [
            {
              cartKey: "line_ambiguous",
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
          createProduct({ id: "prod_price_changed", name: "Price Changed Product", priceMinor: 5_000 }),
        ],
        variants: [
          createVariant(),
          createVariant({ id: "var_price_changed", productId: "prod_price_changed", priceMinor: 8_000 }),
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
      shippingMethods: [createShippingMethod({ feeMinor: 7_500 })],
    });

    expect(result.commitPayload.orderData.shippingAmountMinor).toBe(7_500);
    expect(result.commitPayload.orderData).toMatchObject({
      shippingMethodId: "ship_standard",
      shippingMethodName: "Standard delivery",
      shippingMethodDescription: "Delivered within 2–3 business days",
      shippingMethodBaseAmountMinor: 7_500,
      shippingFeeWaived: false,
    });
    expect(result.commitPayload.orderData.totalAmountMinor).toBe(20_000);
  });

  it("carries the stored minor-unit shipping fee into the delivery snapshot unchanged", async () => {
    const db = createDbMock(
      [[
        [
          createLocation({ id: "city_1", type: "city", parentId: null }),
          createLocation({ id: "zone_1", type: "zone", parentId: "city_1" }),
        ],
        [createShippingMethod({ feeMinor: 1_235 })],
      ]],
      [],
      [],
    );

    const result = await validateStorefrontDeliveryPreflight(
      db,
      {
        city: "city_1",
        zone: "zone_1",
        shippingMethodId: "ship_standard",
      },
      { hasFreeDeliveryProduct: false, subtotalMinor: 0 },
    );

    expect(result.shippingMinor).toBe(1_235);
    expect(result.shippingMethod).toEqual({
      id: "ship_standard",
      name: "Standard delivery",
      description: "Delivered within 2–3 business days",
      baseAmountMinor: 1_235,
      feeWaived: false,
    });
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

  it("requires an active method for free delivery and snapshots the waived fee", async () => {
    const result = await placeOrder({
      inputOverrides: {
        shippingCharge: 999,
      },
      products: [createProduct({ freeDelivery: true })],
      shippingMethods: [createShippingMethod({ feeMinor: 9_000 })],
    });

    expect(result.commitPayload.orderData.shippingAmountMinor).toBe(0);
    expect(result.commitPayload.orderData).toMatchObject({
      shippingMethodId: "ship_standard",
      shippingMethodName: "Standard delivery",
      shippingMethodDescription: "Delivered within 2–3 business days",
      shippingMethodBaseAmountMinor: 9_000,
      shippingFeeWaived: true,
    });
    expect(result.commitPayload.orderData.totalAmountMinor).toBe(12_500);
  });

  it("rejects missing or inactive methods even when delivery is waived", async () => {
    await expect(placeOrder({
      inputOverrides: { shippingMethodId: null },
      products: [createProduct({ freeDelivery: true })],
      shippingMethods: [],
    })).rejects.toThrow("A valid active shipping method is required for this order.");

    await expect(placeOrder({
      products: [createProduct({ freeDelivery: true })],
      shippingMethods: [createShippingMethod({ isActive: false })],
    })).rejects.toThrow("A valid active shipping method is required for this order.");
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

    expect(result.commitPayload.orderData.cityName).toBe("Dhaka");
    expect(result.commitPayload.orderData.zoneName).toBe("Mirpur");
    expect(result.commitPayload.orderData.areaName).toBe("Section 10");
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

describe("createStorefrontOrder prevalidated input trust", () => {
  it("rejects forged prevalidated cart results before reading delivery or building an order", async () => {
    const db = createDbMock([], [], []);

    await expect(
      createStorefrontOrder(
        db,
        createOrderInput(),
        "http://localhost:8787/api/v1/orders",
        undefined,
        {
          valid: true,
          issues: [],
          items: [
            {
              index: 0,
              cartKey: null,
              productId: "prod_standard",
              variantId: "var_standard",
              quantity: 1,
              unitPriceMinor: 100,
              productName: "Forged Product",
              variantLabel: null,
              freeDelivery: true,
              inventoryTracked: false,
              availableQuantity: null,
              taxClassId: null,
              productImageMediaId: null,
              productImage: null,
            },
          ],
          subtotalMinor: 100,
          hasFreeDeliveryProduct: true,
        },
      ),
    ).rejects.toThrow("Checkout cart validation could not be trusted. Please retry checkout.");

    expect(db.select).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("rejects forged prevalidated delivery results after real cart validation and before order reads", async () => {
    const db = createDbMock([], [createProduct()], [createVariant()]);

    await expect(
      createStorefrontOrder(
        db,
        createOrderInput(),
        "http://localhost:8787/api/v1/orders",
        undefined,
        undefined,
        {
          kind: "delivery",
          shippingMinor: 0,
          shippingMethod: {
            id: "forged_shipping",
            name: "Forged delivery",
            description: null,
            baseAmountMinor: 0,
            feeWaived: false,
          },
          cityName: "Forged City",
          zoneName: "Forged Zone",
          areaName: "Forged Area",
        },
      ),
    ).rejects.toThrow("Checkout delivery validation could not be trusted. Please retry checkout.");

    expect(db.batch).not.toHaveBeenCalled();
  });

  it("accepts prevalidated cart and delivery results only when produced by the validators", async () => {
    const input = createOrderInput({ area: "area_1" });
    const cartDb = createDbMock([], [createProduct()], [createVariant()]);
    const cartValidation = await validateStorefrontCartItems(cartDb, input.items, {
      inventoryPool: input.inventoryPool,
    });
    const deliveryDb = createDbMock(
      [
        [
          [
            createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
            createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
            createLocation({ id: "area_1", name: "Section 10", type: "area", parentId: "zone_1" }),
          ],
          [createShippingMethod({ feeMinor: 7_000 })],
        ],
      ],
      [],
      [],
    );
    const deliveryPreflight = await validateStorefrontDeliveryPreflight(
      deliveryDb,
      {
        city: input.city,
        zone: input.zone,
        area: input.area,
        shippingMethodId: input.shippingMethodId,
      },
      cartValidation,
    );
    const orderDb = createDbMock([[[], [], []]], [], []);

    const result = await createStorefrontOrder(
      orderDb,
      input,
      "http://localhost:8787/api/v1/orders",
      undefined,
      cartValidation,
      deliveryPreflight,
      undefined,
      undefined,
      createTrustedStorefrontCheckoutPolicySnapshot({ partialPaymentEnabled: false }),
    );

    expect(result.commitPayload.orderData.cityName).toBe("Dhaka");
    expect(result.commitPayload.orderData.zoneName).toBe("Mirpur");
    expect(result.commitPayload.orderData.areaName).toBe("Section 10");
    expect(result.commitPayload.orderData.shippingAmountMinor).toBe(7_000);
    expect(orderDb.batch).not.toHaveBeenCalled();
  });
});
