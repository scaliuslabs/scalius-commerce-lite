import { describe, expect, it } from "vitest";

import { canDeleteShipment, canRefreshShipment } from "./shipment-action-policy";

describe("shipment action policy", () => {
  it.each(["failed", "cancelled"])("allows deleting %s attempts", (status) => {
    expect(canDeleteShipment({ status })).toBe(true);
  });

  it.each(["creating", "pending", "in_transit", "delivered", "reconcile_required"])(
    "preserves %s shipment history",
    (status) => {
      expect(canDeleteShipment({ status })).toBe(false);
    },
  );

  it("refreshes provider shipments but not own-courier shipments", () => {
    expect(canRefreshShipment({ providerId: "provider_1", providerType: "steadfast" })).toBe(true);
    expect(canRefreshShipment({ providerId: null, providerType: "manual" })).toBe(false);
  });
});
