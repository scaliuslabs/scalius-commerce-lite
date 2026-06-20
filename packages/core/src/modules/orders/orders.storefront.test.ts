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
  locations = [
    createLocation({ id: "city_1", name: "Dhaka", type: "city", parentId: null }),
    createLocation({ id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" }),
  ],
  shippingMethods = [createShippingMethod()],
}: {
  inputOverrides?: Partial<CreateStorefrontOrderInput>;
  products?: ProductRow[];
  locations?: LocationRow[];
  shippingMethods?: ShippingMethodRow[];
} = {}) {
  const db = createDbMock([
    [],
    locations,
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
