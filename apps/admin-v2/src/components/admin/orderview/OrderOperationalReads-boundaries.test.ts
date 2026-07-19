import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  fileURLToPath(new URL("../../../routes/admin/orders/$orderId/index.tsx", import.meta.url)),
  "utf8",
);
const shipmentSource = readFileSync(
  fileURLToPath(new URL("./ShipmentCard.tsx", import.meta.url)),
  "utf8",
);
const paymentSource = readFileSync(
  fileURLToPath(new URL("./PaymentCard.tsx", import.meta.url)),
  "utf8",
);

describe("order operational reads", () => {
  it("does not convert shipment or provider failures into empty arrays", () => {
    expect(routeSource).not.toContain("data: shipments = []");
    expect(routeSource).not.toContain("data: providers = []");
    expect(routeSource).toContain("resolveOrderOperationalReadState");
    expect(routeSource).toContain("operationalReads:");
  });

  it("gives shipments and provider setup explicit loading, unavailable, stale, and empty outcomes", () => {
    expect(shipmentSource).toContain("Delivery providers unavailable");
    expect(shipmentSource).toContain("Shipment history unavailable");
    expect(shipmentSource).toContain("No shipments yet");
    expect(shipmentSource).toContain("Showing the last loaded shipment data");
    expect(shipmentSource).toContain("Retry");
  });

  it("fails COD actions closed while tracking state is unknown", () => {
    expect(paymentSource).toContain("COD tracking unavailable");
    expect(paymentSource).toContain("codReadState.status === \"ready\"");
    expect(paymentSource).toContain("Retry");
  });
});
