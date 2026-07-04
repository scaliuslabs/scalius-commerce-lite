import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ORDERS_ADMIN_SOURCE = fileURLToPath(
  new URL("./orders.admin.ts", import.meta.url),
);

describe("admin order list boundaries", () => {
  it("clamps direct API page and limit inputs before building offsets", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain("const MAX_ORDER_LIST_LIMIT = 100");
    expect(source).toContain("function normalizeListPositiveInteger");
    expect(source).toContain("page: rawPage = 1");
    expect(source).toContain("const page = normalizeListPositiveInteger(rawPage, 1)");
    expect(source).toContain(
      "const limit = normalizeListPositiveInteger(rawLimit, 10, MAX_ORDER_LIST_LIMIT)",
    );
    expect(source).toContain("const offset = (page - 1) * limit");
  });

  it("uses API-provided date bounds exactly", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain("const startTs = Math.floor(startDate.getTime() / 1000)");
    expect(source).toContain("const endTs = Math.floor(endDate.getTime() / 1000)");
    expect(source).not.toContain("setHours(23, 59, 59, 999)");
  });

  it("only applies FTS rank ordering when relevance is explicitly requested", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain('type OrderListSort = "relevance"');
    expect(source).toContain("COALESCE(");
    expect(source).toContain("SELECT rank FROM orders_fts");
    expect(source).toContain('if (rankExpression && sort === "relevance")');
    expect(source).toContain("orderBy(...orderByExpressions)");
    expect(source).toContain('case "relevance":');
    expect(source).not.toContain("if (rankExpression) return rankExpression");
  });

  it("keeps admin payment and fulfillment filters as SQL predicates", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain("paymentStatus?: string");
    expect(source).toContain("paymentMethod?: string");
    expect(source).toContain("fulfillmentStatus?: string");
    expect(source).toContain("paymentRecovery?: OrderPaymentRecoveryFilter");
    expect(source).toContain(
      "whereConditions.push(sql`${orders.paymentStatus} = ${paymentStatus}`)",
    );
    expect(source).toContain(
      "whereConditions.push(sql`${orders.paymentMethod} = ${paymentMethod}`)",
    );
    expect(source).toContain(
      "whereConditions.push(sql`${orders.fulfillmentStatus} = ${fulfillmentStatus}`)",
    );
    expect(source).toContain("whereConditions.push(paymentRecoveryFilterCondition(paymentRecovery))");
  });

  it("summarizes hosted payment recovery without exposing private attempt identity", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");
    const summarySource = source.split("function buildPaymentRecoverySummary")[1]?.split("function orderEditReadyCondition")[0] ?? "";

    expect(source).toContain("paymentSessionAttempts");
    expect(source).toContain("paymentRecovery: buildPaymentRecoverySummary(");
    expect(source).toContain("activePaymentSessionAttemptExistsCondition");
    expect(source).toContain("staleOrFailedPaymentSessionAttemptExistsCondition");
    expect(source).toContain("await assertNoActivePaymentSessionAttemptsForOrders(db, [id])");
    expect(summarySource).toContain('state: "awaiting_payment"');
    expect(summarySource).toContain('state: "processing"');
    expect(summarySource).toContain('state: "needs_attention"');
    expect(summarySource).not.toContain("attemptKey");
    expect(summarySource).not.toContain("requestHash");
    expect(summarySource).not.toContain("responsePayload");
    expect(summarySource).not.toContain("claimId");
  });

  it("blocks active hosted payment setup before admin order mutations", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain('from "../payments/payment-session-attempts"');
    expect(source).toContain("await assertNoActivePaymentSessionAttempt(db, id)");
    expect(source).toContain("await assertNoActivePaymentSessionAttemptsForOrders(db, [id])");
    expect(source).toContain("await assertNoActivePaymentSessionAttemptsForOrders(db, affectedOrders.map((order) => order.id))");
    expect(source).toContain("noActivePaymentSessionAttemptForOrderIdCondition(orderId)");
    expect(source).toContain("noActivePaymentSessionAttemptForOrderIdCondition(id)");
    expect(source).toContain("noActivePaymentSessionAttemptForOrderIdCondition(id),");
  });

  it("adds active refund operation summaries to order list rows", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain("listActiveRefundOperationsForOrders");
    expect(source).toContain("const activeRefundOperations = await listActiveRefundOperationsForOrders(db, orderIds)");
    expect(source).toContain("activeRefundOperation: activeRefundOperations.get(order.id) ?? null");
  });

  it("adds sanitized shipment recovery summaries to order list and detail rows", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain("OrderShipmentRecoverySummary");
    expect(source).toContain("function buildShipmentRecoverySummary");
    expect(source).toContain("shipmentRecovery: buildShipmentRecoverySummary(order, latestShipment, nowSeconds)");
    expect(source).toContain("ShipmentStatus.RECONCILE_REQUIRED");
    expect(source).toContain("Shipment creation running");
    expect(source).toContain("canRetryCreate: true");
  });

  it("validates manual order SKUs before create/update inventory work", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain("export async function resolveAdminOrderItemInventory");
    expect(source).toContain("innerJoin(products, eq(products.id, productVariants.productId))");
    expect(source).toContain("variantDeletedAt: productVariants.deletedAt");
    expect(source).toContain("productActive: products.isActive");
    expect(source).toContain("productDeletedAt: products.deletedAt");
    expect(source).toContain('"VARIANT_MISMATCH"');
    expect(source).toContain('"PRODUCT_UNAVAILABLE"');
    expect(source).toContain("const trackedItems = await resolveAdminOrderItemInventory(db, data.items);");
    expect(source).toContain("const trackedNewItems = await resolveAdminOrderItemInventory(db, data.items);");
    expect(source).not.toContain("loadVariantTrackingMap");
    expect(source).not.toContain("trackingByVariantId.get(item.variantId) ?? true");
  });

  it("recomputes admin order payment state when totals are created or edited", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain('import { computeOrderPaymentState } from "../payments/payment-state";');
    expect(source).toContain("const initialPaymentState = computeOrderPaymentState({");
    expect(source).toContain("paidAmount: initialPaymentState.paidAmount");
    expect(source).toContain("balanceDue: initialPaymentState.balanceDue");
    expect(source).toContain("paymentStatus: initialPaymentState.paymentStatus");
    expect(source).toContain("const nextPaymentState = computeOrderPaymentState({");
    expect(source).toContain("paidAmount: existingOrder.paidAmount");
    expect(source).toContain("paidAmount: nextPaymentState.paidAmount");
    expect(source).toContain("balanceDue: nextPaymentState.balanceDue");
    expect(source).toContain("paymentStatus: nextPaymentState.paymentStatus");
  });
});
