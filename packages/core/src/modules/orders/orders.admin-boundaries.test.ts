import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ORDERS_ADMIN_SOURCE = fileURLToPath(
  new URL("./orders.admin.ts", import.meta.url),
);

describe("admin order list boundaries", () => {
  it("guards full item replacement and exposes archive without hard deletion", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");
    const updateSource = source.slice(
      source.indexOf("export async function updateOrder"),
      source.indexOf("async function updateCustomerStatsService"),
    );
    const archiveSource = source.slice(source.indexOf("export async function archiveOrders"));

    expect(updateSource).toContain("await assertOrderItemsHaveNoReturnHistory(db, id)");
    expect(updateSource).toContain("await assertOrderHasNoIssuedInvoice(db, id)");
    expect(source).not.toContain("export async function permanentlyDeleteOrder");
    expect(source).not.toContain("export async function bulkDeleteOrders");
    expect(source).not.toContain("db.delete(orders)");
    expect(archiveSource).toContain("getOrderArchiveStatusBlockedReason");
    expect(archiveSource).toContain("eq(orders.version, expectedVersion)");
    expect(archiveSource).toContain("isNull(orders.deletedAt)");
    expect(archiveSource).toContain("archivedAt: sql`unixepoch()`");
    expect(archiveSource).toContain("isNull(orders.archivedAt)");
    expect(archiveSource).not.toContain("applyInventoryForStatusChange");
    expect(archiveSource).not.toContain("inventoryAction:");
  });

  it("returns the order CAS version required by item-return creation", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");
    const detailStart = source.indexOf("export async function getOrderDetails");
    const detailEnd = source.indexOf("export async function createOrder", detailStart);
    const detailSource = source.slice(detailStart, detailEnd);

    expect(detailSource).toContain("version: orders.version");
  });

  it("requires the browser-loaded version and edit readiness before full replacement", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");
    const updateSource = source.slice(
      source.indexOf("export async function updateOrder"),
      source.indexOf("async function updateCustomerStatsService"),
    );

    expect(updateSource).toContain("existingOrder.version !== data.expectedVersion");
    expect(updateSource).toContain("const expectedVersion = data.expectedVersion");
    expect(updateSource).toContain("await getAdminOrderFullEditReadiness(db, id)");
    expect(updateSource).toContain("eq(orders.version, expectedVersion)");
    expect(updateSource).toContain("Use the order status action for operational progress");
    expect(updateSource).not.toContain("assertGenericAdminOrderStatusTransition");
  });

  it("retries only transient D1 failures while reading order details", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");
    const detailStart = source.indexOf("export async function getOrderDetails");
    const detailEnd = source.indexOf("export async function createOrder", detailStart);
    const detailSource = source.slice(detailStart, detailEnd);

    expect(detailSource).toContain("return retryTransientD1(() => getOrderDetailsOnce(db, id))");
    expect(detailSource).toContain("async function getOrderDetailsOnce");
  });

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
    expect(source).toContain("await assertNoActivePaymentSessionAttemptsForOrders(db, requestedIds)");
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
    expect(source).toContain("await assertNoActivePaymentSessionAttemptsForOrders(db, requestedIds)");
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
    expect(source).toContain("const resolvedItems = await resolveAdminOrderItemInventory(");
    expect(source).toContain("{ catalogPricePrecision: currency.decimalPlaces }");
    expect(source).toContain("const trackedNewItems = await resolveAdminOrderItemInventory(db, money.normalizedItems);");
    expect(source).not.toContain("loadVariantTrackingMap");
    expect(source).not.toContain("trackingByVariantId.get(item.variantId) ?? true");
  });

  it("commits manual-order idempotency evidence with the order write", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");
    const createSource = source.slice(
      source.indexOf("export async function createOrder"),
      source.indexOf("interface UpdateOrderItem"),
    );

    expect(createSource).toContain("buildAdminOrderCreateAttemptIdentity(data, actorId)");
    expect(createSource).toContain("claimAdminOrderCreateAttempt<{ id: string }>");
    expect(createSource).toContain("buildAdminOrderCreateAttemptGuard(db, attempt)");
    expect(createSource).toContain("writeBatch.push(buildAdminOrderCreateAttemptCommit(db, attempt, response))");
    expect(createSource).toContain("resolveAdminOrderCreateAttempt<{ id: string }>");
    expect(createSource.indexOf("resolveAdminOrderCreateAttempt<{ id: string }>")).toBeLessThan(
      createSource.indexOf("releaseReservedStockBatch(db, reservationEntries, orderId"),
    );
    expect(createSource.indexOf("isAdminOrderCreateAttemptGuardError(batchError)")).toBeLessThan(
      createSource.indexOf("releaseReservedStockBatch(db, reservationEntries, orderId"),
    );
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

  it("keeps production order writes off replay-unsafe inventory primitives", () => {
    const source = readFileSync(ORDERS_ADMIN_SOURCE, "utf8");

    expect(source).toContain("applyClaimedInventoryEntryBatch");
    expect(source).toContain("releaseReservedStockBatch");
    expect(source).toContain("adminOrderInventoryClaimKey");
    expect(source).toContain("reservationKey:");
    expect(source).toContain("releaseKey:");
    expect(source).not.toContain("deductMultiple");
    expect(source).not.toContain("releaseMultiple");
    expect(source).not.toContain("restoreDeductedMultiple");
  });
});
