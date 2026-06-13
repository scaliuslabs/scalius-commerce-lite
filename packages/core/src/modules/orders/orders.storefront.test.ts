import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { InventoryPool, PaymentMethod } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { createStorefrontOrder } from "./orders.storefront";
import type { CreateStorefrontOrderInput } from "./orders.types";

interface ProductRow {
  id: string;
  price: number;
  discountPercentage: number | null;
  discountType: string | null;
  discountAmount: number | null;
  freeDelivery: boolean;
}

interface ShippingMethodRow {
  id: string;
  fee: number;
  isActive: boolean;
  deletedAt: Date | null;
}

function createProduct(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "prod_standard",
    price: 100,
    discountPercentage: null,
    discountType: null,
    discountAmount: null,
    freeDelivery: false,
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

function createOrderInput(overrides: Partial<CreateStorefrontOrderInput> = {}): CreateStorefrontOrderInput {
  return {
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
        variantId: null,
        quantity: 1,
        price: 1,
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

function createDbMock(readResults: unknown[]): Database {
  const statement = {
    where: vi.fn(() => ({ statement: "where" })),
    limit: vi.fn(() => ({ statement: "limit" })),
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => statement),
    })),
    batch: vi.fn(async () => readResults),
  } as unknown as Database;
}

async function placeOrder({
  inputOverrides,
  products = [createProduct()],
  shippingMethods = [createShippingMethod()],
}: {
  inputOverrides?: Partial<CreateStorefrontOrderInput>;
  products?: ProductRow[];
  shippingMethods?: ShippingMethodRow[];
} = {}) {
  const db = createDbMock([
    [],
    [
      { id: "city_1", name: "Dhaka" },
      { id: "zone_1", name: "Mirpur" },
    ],
    [],
    [],
    products,
    [],
    shippingMethods,
  ]);

  return createStorefrontOrder(
    db,
    createOrderInput(inputOverrides),
    "http://localhost:8787/api/v1/orders",
    vi.fn(async () => null),
    vi.fn(() => 0),
  );
}

describe("createStorefrontOrder shipping verification", () => {
  it("derives shipping charge from the selected method instead of caller input", async () => {
    const result = await placeOrder({
      inputOverrides: { shippingCharge: 1 },
      shippingMethods: [createShippingMethod({ fee: 75 })],
    });

    expect(result.queuePayload.orderData.shippingCharge).toBe(75);
    expect(result.totalAmount).toBe(175);
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
    expect(result.totalAmount).toBe(100);
  });
});
