import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryShipment } from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  checkShipmentStatus: vi.fn(),
  getDeliveryProvider: vi.fn(),
  getShipment: vi.fn(),
  updateOrderStatusFromShipment: vi.fn(),
  invalidateProductAvailabilityCaches: vi.fn(),
  enqueueOrderStatusChangeNotification: vi.fn(),
}));

vi.mock("@scalius/core/modules/delivery/delivery.service", () => ({
  checkShipmentStatus: mocks.checkShipmentStatus,
  getDeliveryProvider: mocks.getDeliveryProvider,
  getShipment: mocks.getShipment,
}));

vi.mock("@scalius/core/modules/delivery/tracking", () => ({
  updateOrderStatusFromShipment: mocks.updateOrderStatusFromShipment,
}));

vi.mock("../../utils/cache-invalidation", () => ({
  invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

vi.mock("../../utils/order-notification-queue", () => ({
  enqueueOrderStatusChangeNotification: mocks.enqueueOrderStatusChangeNotification,
}));

import { checkAndSyncShipmentStatus } from "./shipment-status-sync";

function shipment(overrides: Partial<DeliveryShipment> = {}): DeliveryShipment {
  return {
    id: "ship_1",
    orderId: "order_1",
    providerId: "provider_1",
    providerType: "steadfast",
    externalId: "ext_1",
    trackingId: "track_old",
    trackingUrl: null,
    courierName: null,
    status: "pending",
    rawStatus: null,
    note: null,
    metadata: null,
    lastChecked: null,
    shipmentItems: null,
    shipmentAmount: null,
    isFinalShipment: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function createDbMock() {
  const where = vi.fn(() => Promise.resolve());
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { update }, set, where };
}

describe("admin shipment status sync helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDeliveryProvider.mockResolvedValue({ id: "provider_1", name: "Steadfast" });
    mocks.invalidateProductAvailabilityCaches.mockResolvedValue(undefined);
    mocks.enqueueOrderStatusChangeNotification.mockResolvedValue({ enqueued: true });
  });

  it("syncs order status, availability caches, and notifications after provider status checks", async () => {
    const initialShipment = shipment();
    const updatedShipment = shipment({
      status: "delivered",
      rawStatus: "Delivered",
      trackingId: "track_new",
      metadata: "{}",
    });
    const orderStatusChange = {
      orderId: "order_1",
      previousStatus: "shipped",
      newStatus: "delivered",
      version: 3,
    };
    const { db } = createDbMock();
    const queue = { send: vi.fn() };

    mocks.checkShipmentStatus.mockResolvedValue({
      shipmentId: "ship_1",
      externalId: "ext_1",
      orderId: "order_1",
      trackingId: "track_checked",
      status: "delivered",
      rawStatus: "Delivered",
      metadata: {},
    });
    mocks.getShipment.mockResolvedValue(updatedShipment);
    mocks.updateOrderStatusFromShipment.mockResolvedValue(orderStatusChange);

    const result = await checkAndSyncShipmentStatus({
      db: db as never,
      shipment: initialShipment,
      encryptionKey: "credential-key",
      c: { env: { ORDER_NOTIFICATIONS_QUEUE: queue } as unknown as Env },
      source: "orders-shipment-status",
    });

    expect(mocks.checkShipmentStatus).toHaveBeenCalledWith(
      db,
      "ship_1",
      "credential-key",
    );
    expect(mocks.updateOrderStatusFromShipment).toHaveBeenCalledWith(
      db,
      "ship_1",
      "delivered",
    );
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      db,
      { orderIds: ["order_1"] },
      { env: { ORDER_NOTIFICATIONS_QUEUE: queue } },
    );
    expect(mocks.enqueueOrderStatusChangeNotification).toHaveBeenCalledWith({
      db,
      queue,
      statusChange: orderStatusChange,
      trackingId: "track_new",
      source: "orders-shipment-status",
    });
    expect(result.payload).toMatchObject({
      id: "ship_1",
      status: "delivered",
      statusChanged: true,
      orderStatusUpdate: true,
      providerName: "Steadfast",
      providerType: "steadfast",
      lastChecked: expect.any(String),
    });
  });
});
