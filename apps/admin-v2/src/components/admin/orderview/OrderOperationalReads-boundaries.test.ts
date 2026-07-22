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
const orderViewHeaderSource = readFileSync(
  fileURLToPath(new URL("./OrderViewHeader.tsx", import.meta.url)),
  "utf8",
);
const orderStatusSource = readFileSync(
  fileURLToPath(new URL("./OrderStatusCard.tsx", import.meta.url)),
  "utf8",
);
const notificationsSource = readFileSync(
  fileURLToPath(new URL("./OrderNotificationsCard.tsx", import.meta.url)),
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
    expect(shipmentSource).toContain(
      'canTransitionTo("order", order.status, "shipped")',
    );
  });

  it("fails COD actions closed while tracking state is unknown", () => {
    expect(paymentSource).toContain("COD tracking unavailable");
    expect(paymentSource).toContain("codReadState.status === \"ready\"");
    expect(paymentSource).toContain("Retry");
  });

  it("shares the server COD state policy and hides invalid actions", () => {
    expect(paymentSource).toContain(
      'canProcessOrderCodAction(order.status, "collected")',
    );
    expect(paymentSource).toContain(
      'canProcessOrderCodAction(order.status, "failed")',
    );
    expect(paymentSource).toContain(
      'canProcessOrderCodAction(order.status, "returned")',
    );
    expect(paymentSource).toContain("canRecordCodCollection ? (");
    expect(paymentSource).toContain("canRecordCodFailure ? (");
    expect(paymentSource).toContain("canRecordCodReturn && codTracking");
  });

  it("keeps primary order controls touch-sized on narrow merchant viewports", () => {
    expect(orderViewHeaderSource).toContain(
      'className="h-11 gap-1.5 rounded-lg',
    );
    expect(orderStatusSource).toContain(
      'className="h-11 border-border bg-background',
    );
    expect(paymentSource).toContain('className="min-h-11 flex-1');
    expect(shipmentSource).toContain('className="min-h-11 w-full');
    expect(notificationsSource).toContain('className="h-11 gap-1.5 sm:h-8"');
  });

  it("keeps provider identifiers behind an optional technical disclosure", () => {
    expect(paymentSource.match(/Technical details/g)).toHaveLength(2);
    expect(paymentSource).toContain("attempt.providerSessionId");
    expect(paymentSource).toContain("attempt.providerRefundId");
  });

  it("describes COD collection and failure dialogs for assistive technology", () => {
    expect(paymentSource).toContain("Confirm the cash received after delivery.");
    expect(paymentSource).toContain("order delivered");
    expect(paymentSource).toContain(
      "Record the failed cash-on-delivery attempt and its reason.",
    );
  });
});
