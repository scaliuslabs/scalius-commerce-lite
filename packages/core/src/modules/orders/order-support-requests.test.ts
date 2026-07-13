import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  FulfillmentStatus,
  OrderStatus,
  PaymentStatus,
} from "@scalius/database/schema";
import {
  getAdminOrderSupportRequestTransition,
  getCustomerOrderSupportRequestActions,
  customerAccountOwnershipCondition,
  type CustomerOrderSupportRequestType,
} from "./order-support-requests";

describe("customer account order ownership", () => {
  it("authorizes private account actions only through verified account ownership", () => {
    const compiled = new SQLiteSyncDialect().sqlToQuery(
      customerAccountOwnershipCondition("cust_account"),
    );

    expect(compiled.sql).toContain('"orders"."account_owner_customer_id" = ?');
    expect(compiled.sql).not.toContain('"orders"."customer_id" = ?');
    expect(compiled.params).toEqual(["cust_account"]);
  });
});

const SUPPORT_REQUEST_SOURCE = fileURLToPath(
  new URL("./order-support-requests.ts", import.meta.url),
);

function actionState(overrides: Partial<{
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  paidAmount: number;
}> = {}) {
  return {
    id: "order_1",
    status: overrides.status ?? OrderStatus.PENDING,
    paymentStatus: overrides.paymentStatus ?? PaymentStatus.UNPAID,
    fulfillmentStatus: overrides.fulfillmentStatus ?? FulfillmentStatus.PENDING,
    paidAmount: overrides.paidAmount ?? 0,
  };
}

function context(overrides: Partial<{
  hasShipment: boolean;
  hasActiveRefundOperation: boolean;
  activeRequestTypes: ReadonlySet<CustomerOrderSupportRequestType>;
}> = {}) {
  return {
    hasShipment: overrides.hasShipment ?? false,
    hasActiveRefundOperation: overrides.hasActiveRefundOperation ?? false,
    activeRequestTypes: overrides.activeRequestTypes ?? new Set<CustomerOrderSupportRequestType>(),
  };
}

function actionByType(type: CustomerOrderSupportRequestType, actions = getCustomerOrderSupportRequestActions(actionState(), context())) {
  const action = actions.find((item) => item.type === type);
  if (!action) throw new Error(`Missing ${type} action`);
  return action;
}

describe("order support request eligibility", () => {
  it("allows cancellation only before shipment starts", () => {
    expect(actionByType("cancel_pre_shipment").eligible).toBe(true);

    expect(actionByType(
      "cancel_pre_shipment",
      getCustomerOrderSupportRequestActions(actionState(), context({ hasShipment: true })),
    ).eligible).toBe(false);
    expect(actionByType(
      "cancel_pre_shipment",
      getCustomerOrderSupportRequestActions(actionState({ fulfillmentStatus: FulfillmentStatus.PARTIAL }), context()),
    ).eligible).toBe(false);
    expect(actionByType(
      "cancel_pre_shipment",
      getCustomerOrderSupportRequestActions(actionState({ status: OrderStatus.SHIPPED }), context()),
    ).eligible).toBe(false);
  });

  it("allows returns after shipment or delivery states", () => {
    for (const status of [OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.COMPLETED]) {
      expect(actionByType(
        "return",
        getCustomerOrderSupportRequestActions(actionState({ status }), context()),
      ).eligible).toBe(true);
    }

    expect(actionByType(
      "return",
      getCustomerOrderSupportRequestActions(actionState({ status: OrderStatus.CONFIRMED }), context()),
    ).eligible).toBe(false);
  });

  it("allows refund requests only for paid post-shipment states", () => {
    expect(actionByType(
      "refund",
      getCustomerOrderSupportRequestActions(actionState({
        status: OrderStatus.DELIVERED,
        paymentStatus: PaymentStatus.PAID,
        paidAmount: 1200,
      }), context()),
    ).eligible).toBe(true);

    expect(actionByType(
      "refund",
      getCustomerOrderSupportRequestActions(actionState({
        status: OrderStatus.DELIVERED,
        paymentStatus: PaymentStatus.UNPAID,
        paidAmount: 0,
      }), context()),
    ).eligible).toBe(false);
    expect(actionByType(
      "refund",
      getCustomerOrderSupportRequestActions(actionState({
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        paidAmount: 1200,
      }), context()),
    ).eligible).toBe(false);
  });

  it("blocks every request while another request or refund operation is active", () => {
    const openRequestActions = getCustomerOrderSupportRequestActions(actionState(), context({
      activeRequestTypes: new Set<CustomerOrderSupportRequestType>(["return"]),
    }));
    expect(openRequestActions.every((action) => !action.eligible)).toBe(true);
    expect(openRequestActions.every((action) => action.disabledReason?.includes("already open"))).toBe(true);

    const activeRefundActions = getCustomerOrderSupportRequestActions(actionState({
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.PAID,
      paidAmount: 1200,
    }), context({ hasActiveRefundOperation: true }));
    expect(activeRefundActions.every((action) => !action.eligible)).toBe(true);
    expect(activeRefundActions.every((action) => action.disabledReason?.includes("refund is already being processed"))).toBe(true);
  });

  it("does not import order, payment, shipment, COD, or inventory mutators", () => {
    const source = readFileSync(SUPPORT_REQUEST_SOURCE, "utf8");

    expect(source).not.toContain("processRefund");
    expect(source).not.toContain("refund-service");
    expect(source).not.toContain("updateOrderStatus");
    expect(source).not.toContain("./orders.fulfillment");
    expect(source).not.toContain('from "./orders.fulfillment"');
    expect(source).not.toContain("codTracking");
    expect(source).not.toContain("reserveStock");
    expect(source).not.toContain("deductMultiple");
  });
});

describe("admin order support request transitions", () => {
  it("allows the expected review and settle lifecycle", () => {
    expect(getAdminOrderSupportRequestTransition("submitted", "under_review")).toEqual({
      changed: true,
      active: true,
      terminal: false,
    });
    expect(getAdminOrderSupportRequestTransition("submitted", "approved")).toEqual({
      changed: true,
      active: true,
      terminal: false,
    });
    expect(getAdminOrderSupportRequestTransition("under_review", "rejected")).toEqual({
      changed: true,
      active: false,
      terminal: true,
    });
    expect(getAdminOrderSupportRequestTransition("approved", "completed")).toEqual({
      changed: true,
      active: false,
      terminal: true,
    });
  });

  it("makes same-status retries idempotent without inventing another event", () => {
    expect(getAdminOrderSupportRequestTransition("under_review", "under_review")).toEqual({
      changed: false,
      active: true,
      terminal: false,
    });
    expect(getAdminOrderSupportRequestTransition("completed", "completed")).toEqual({
      changed: false,
      active: false,
      terminal: true,
    });
  });

  it("exposes stable support request notification labels", async () => {
    const module = await import("./order-support-requests");

    expect(module.getOrderSupportRequestTypeLabel("refund")).toBe("Refund request");
    expect(module.getOrderSupportRequestTypeLabel("unknown")).toBe("Support request");
    expect(module.getOrderSupportRequestStatusLabel("under_review")).toBe("Under review");
    expect(module.getOrderSupportRequestStatusLabel("custom")).toBe("custom");
  });

  it("blocks reopening or skipping unsupported transitions", () => {
    expect(() => getAdminOrderSupportRequestTransition("completed", "under_review"))
      .toThrow("already been settled");
    expect(() => getAdminOrderSupportRequestTransition("approved", "rejected"))
      .toThrow("cannot move");
    expect(() => getAdminOrderSupportRequestTransition("submitted", "submitted"))
      .toThrow("Unsupported");
  });
});
