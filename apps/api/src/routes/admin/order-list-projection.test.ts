import { describe, expect, it } from "vitest";
import { projectOrderListResult } from "./order-list-projection";

describe("order list response projection", () => {
  it("matches the documented summary and strips internal shipment authority", () => {
    const result = projectOrderListResult({
      orders: [{
        id: "order_1",
        customerName: "Customer",
        customerPhone: "+8801700000000",
        customerEmail: null,
        customerId: null,
        totalAmount: 100,
        shippingCharge: 10,
        discountAmount: 0,
        status: "confirmed",
        paymentStatus: "unpaid",
        paymentMethod: "cod",
        fulfillmentStatus: "pending",
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
        updatedAt: new Date("2026-08-16T01:00:00.000Z"),
        version: 1,
        city: null,
        zone: null,
        area: null,
        cityName: null,
        zoneName: null,
        areaName: null,
        itemCount: 1,
        totalQuantity: 1,
        latestShipment: {
          id: "shipment_1",
          providerId: null,
          providerType: "manual",
          providerName: null,
          status: "in_transit",
          rawStatus: "in_transit",
          externalId: null,
          trackingId: "TRACK-1",
          lastChecked: null,
          updatedAt: new Date("2026-08-16T01:00:00.000Z"),
          createdAt: new Date("2026-08-16T00:30:00.000Z"),
        },
        shipmentRecovery: {
          state: "none",
          severity: "info",
          activeLock: false,
          label: "No shipment recovery",
          message: null,
          shipmentId: null,
          status: null,
          providerType: null,
          canRefresh: false,
          canRetryCreate: false,
          updatedAt: null,
        },
        paymentRecovery: {
          state: "none",
          label: "No payment recovery",
          message: null,
          gateway: null,
          paymentType: null,
          status: null,
          attempts: 0,
          activeProcessing: false,
          staleProcessing: false,
          updatedAt: null,
        },
        activeRefundOperation: null,
        fullEditReadiness: { allowed: true, reason: null },
        shipmentClaimId: "secret_claim",
        shipmentClaimExpiresAt: 1_800_000_000,
        paidAmount: 0,
        hasTaxSnapshot: true,
      }],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    expect(result.orders[0]).toMatchObject({
      id: "order_1",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T01:00:00.000Z",
    });
    expect(result.orders[0]).not.toHaveProperty("shipmentClaimId");
    expect(result.orders[0]).not.toHaveProperty("shipmentClaimExpiresAt");
    expect(result.orders[0]).not.toHaveProperty("paidAmount");
    expect(result.orders[0]).not.toHaveProperty("hasTaxSnapshot");
    expect(result.orders[0]?.latestShipment?.updatedAt).toBeInstanceOf(Date);
  });
});
