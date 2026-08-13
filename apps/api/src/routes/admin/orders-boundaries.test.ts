import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const ADMIN_ORDERS_ROUTE_SOURCE = fileURLToPath(
    new URL("./orders.ts", import.meta.url),
);
const ORDER_CSV_ARTIFACT_SOURCE = fileURLToPath(
    new URL("../../../../../packages/core/src/modules/orders/order-csv-export.ts", import.meta.url),
);
const ADMIN_ORDERS_INVOICE_ROUTE_SOURCE = fileURLToPath(
    new URL("./orders-invoice.ts", import.meta.url),
);

describe("admin orders route boundaries", () => {
    it("keeps relevance as an explicit order-list search sort mode", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");

        expect(source).toContain('type OrderListSort = "relevance"');
        expect(source).toContain('z.enum([');
        expect(source).toContain('"relevance"');
        expect(source).toContain('"updatedAt"');
        expect(source).toContain("const effectiveSort: OrderListSort = query.sort");
        expect(source).toContain('?? (query.search?.trim() ? "relevance" : "updatedAt")');
        expect(source).toContain("sort: effectiveSort");
    });

    it("passes payment and fulfillment list filters through the API route", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");

        expect(source).toContain("const paymentStatusQuerySchema = z.enum([");
        expect(source).toContain("const paymentMethodQuerySchema = z.enum([");
        expect(source).toContain("const fulfillmentStatusQuerySchema = z.enum([");
        expect(source).toContain("const paymentRecoveryQuerySchema = z.enum([");
        expect(source).toContain("paymentStatus: paymentStatusQuerySchema.optional()");
        expect(source).toContain("paymentMethod: paymentMethodQuerySchema.optional()");
        expect(source).toContain("fulfillmentStatus: fulfillmentStatusQuerySchema.optional()");
        expect(source).toContain("paymentRecovery: paymentRecoveryQuerySchema.optional()");
        expect(source).toContain("paymentStatus: query.paymentStatus");
        expect(source).toContain("paymentMethod: query.paymentMethod");
        expect(source).toContain("fulfillmentStatus: query.fulfillmentStatus");
        expect(source).toContain("paymentRecovery: query.paymentRecovery");
    });

    it("hydrates only exact order-line SKUs with their normalized option selections", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");
        const formDataRoute = source.split("// ─── GET /:id/form-data")[1] ?? "";

        expect(formDataRoute).toContain("loadVariantSelectedOptions(");
        expect(formDataRoute).toContain("const orderProductIds");
        expect(formDataRoute).toContain("const orderVariantIds");
        expect(formDataRoute).toContain("json_each(${JSON.stringify(orderProductIds)})");
        expect(formDataRoute).toContain("json_each(${JSON.stringify(orderVariantIds)})");
        expect(formDataRoute).toContain("allVariants.map((variant) => variant.id)");
        expect(formDataRoute).toContain("selectedOptions: selectedOptionsByVariant.get(variant.id) ?? []");
        expect(formDataRoute).not.toContain("const allProductIds = allProducts.map");
        expect(source).toContain("selectedOptions: z.array(selectedProductOptionSchema)");
    });

    it("keeps manual-order catalog discovery active-only and bounded", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");
        const catalogRoute = source.split("// ─── GET /catalog-products")[1]
            ?.split("// ─── GET / (List)")[0] ?? "";

        expect(catalogRoute).toContain('path: "/catalog-products"');
        expect(catalogRoute).toContain(".max(20)");
        expect(catalogRoute).toContain(".max(100)");
        expect(catalogRoute).toContain("activeOnly: true");
        expect(catalogRoute).toContain('sort: "name"');
        expect(source.indexOf("const catalogProductsRoute"))
            .toBeLessThan(source.indexOf("const getOrderRoute"));
    });

    it("keeps order-list refund recovery visibility as a compact summary", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");
        const entitiesSource = readFileSync(
            fileURLToPath(new URL("../../schemas/entities.ts", import.meta.url)),
            "utf8",
        );
        const summarySchema = entitiesSource.split("export const orderSummarySchema")[1]?.split("/** Order item")[0] ?? "";
        const listActiveRefundSchema = entitiesSource.split("export const orderListActiveRefundOperationSchema")[1]?.split("/** Order summary")[0] ?? "";
        const shipmentRecoverySchema = entitiesSource.split("export const orderShipmentRecoverySchema")[1]?.split("export const orderListActiveRefundOperationSchema")[0] ?? "";

        expect(summarySchema).toContain("activeRefundOperation: orderListActiveRefundOperationSchema.nullable()");
        expect(summarySchema).toContain("shipmentRecovery: orderShipmentRecoverySchema");
        expect(summarySchema).not.toContain("refundAttempts: z.array(orderRefundAttemptSchema)");
        expect(listActiveRefundSchema).toContain("attemptCount: z.number()");
        expect(listActiveRefundSchema).toContain("providerStatus: z.string().nullable()");
        expect(listActiveRefundSchema).not.toContain("providerRefundId");
        expect(listActiveRefundSchema).not.toContain("lastError");
        expect(shipmentRecoverySchema).toContain('state: z.enum(["none", "creating", "needs_attention", "failed"])');
        expect(shipmentRecoverySchema).toContain("activeLock: z.boolean()");
        expect(shipmentRecoverySchema).toContain("canRetryCreate: z.boolean()");
        expect(shipmentRecoverySchema).not.toContain("shipmentClaimId");
        expect(shipmentRecoverySchema).not.toContain("metadata");
        expect(source).toContain("orderSummarySchema");
    });

    it("keeps hosted-payment recovery queue and export sanitized", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");
        const recoveryListRoute = source.split("const paymentRecoveryListRoute = createRoute")[1]?.split("const paymentRecoveryExportRoute = createRoute")[0] ?? "";
        const recoveryExportRoute = source.split("const paymentRecoveryExportRoute = createRoute")[1]?.split("// ─── POST / (Create)")[0] ?? "";
        const csvBuilder = readFileSync(ORDER_CSV_ARTIFACT_SOURCE, "utf8");

        expect(source.indexOf("const paymentRecoveryListRoute = createRoute"))
            .toBeLessThan(source.indexOf("const createOrderRoute = createRoute"));
        expect(source.indexOf("const paymentRecoveryExportRoute = createRoute"))
            .toBeLessThan(source.indexOf("const createOrderRoute = createRoute"));

        expect(recoveryListRoute).toContain('path: "/payment-recovery"');
        expect(recoveryListRoute).toContain('summary: "List hosted-payment recovery orders"');
        expect(recoveryListRoute).toContain('paginatedEnvelope("orders", orderSummarySchema)');
        expect(recoveryListRoute).toContain("paymentRecovery: query.state as OrderPaymentRecoveryFilter");

        expect(recoveryExportRoute).toContain('path: "/payment-recovery/export"');
        expect(recoveryExportRoute).toContain('summary: "Export hosted-payment recovery orders as CSV"');
        expect(recoveryExportRoute).toContain("PAYMENT_RECOVERY_EXPORT_MAX_ROWS");
        expect(recoveryExportRoute).toContain('"Content-Disposition"');
        expect(recoveryExportRoute).toContain('"Content-Length"');
        expect(recoveryExportRoute).toContain('"X-Export-Row-Count"');
        expect(recoveryExportRoute).toContain('"X-Export-Limited"');
        expect(recoveryExportRoute).toContain('"X-Export-Truncated-By"');
        expect(recoveryExportRoute).toContain('"X-Export-Artifact-Bytes"');
        expect(recoveryExportRoute).toContain('"X-Export-Max-Bytes"');
        expect(recoveryExportRoute).toContain("paymentRecovery: query.state as OrderPaymentRecoveryFilter");
        expect(recoveryExportRoute).toContain("status: query.status || undefined");
        expect(recoveryExportRoute).toContain("statusGroup: query.statusGroup");
        expect(recoveryExportRoute).toContain("paymentStatus: query.paymentStatus");
        expect(recoveryExportRoute).toContain("fulfillmentStatus: query.fulfillmentStatus");
        expect(recoveryExportRoute).toContain('showArchived: query.archived === "true"');

        expect(csvBuilder).toContain('"Recovery State"');
        expect(csvBuilder).toContain('"Recovery Gateway"');
        expect(csvBuilder).toContain('"Recovery Attempt Status"');
        expect(csvBuilder).toContain("order.paymentRecovery.state");
        expect(csvBuilder).toContain("order.paymentRecovery.gateway");
        expect(csvBuilder).toContain("order.paymentRecovery.status");
        expect(csvBuilder).not.toContain("attemptKey");
        expect(csvBuilder).not.toContain("requestHash");
        expect(csvBuilder).not.toContain("responsePayload");
        expect(csvBuilder).not.toContain("claimId");
        expect(csvBuilder).not.toContain("providerSessionId");
        expect(csvBuilder).not.toContain("providerCorrelationId");
        expect(csvBuilder).not.toContain("lastError");
    });

    it("keeps general order CSV export bounded and spreadsheet-safe", () => {
        const routeSource = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");
        const csvBuilder = readFileSync(ORDER_CSV_ARTIFACT_SOURCE, "utf8");
        const exportRoute = routeSource.split("const exportOrdersRoute = createRoute")[1]?.split("const paymentRecoveryListRoute = createRoute")[0] ?? "";

        expect(exportRoute).toContain('path: "/export"');
        expect(exportRoute).toContain("ORDER_EXPORT_MAX_ROWS");
        expect(exportRoute).toContain('"Content-Disposition"');
        expect(exportRoute).toContain('"Content-Length"');
        expect(exportRoute).toContain('"X-Export-Row-Count"');
        expect(exportRoute).toContain('"X-Export-Limited"');
        expect(exportRoute).toContain('"X-Export-Truncated-By"');
        expect(exportRoute).toContain('"X-Export-Artifact-Bytes"');
        expect(exportRoute).toContain('"X-Export-Max-Bytes"');
        expect(exportRoute).toContain("createOrdersCsvArtifactBuilder()");
        expect(exportRoute).toContain("if (!csvBuilder.append(order)) break exportPages");
        expect(exportRoute).toContain("csvStream(artifact.chunks)");
        expect(csvBuilder).toContain("spreadsheetSafeCsvCell");
        expect(csvBuilder).toContain("/^[\\t\\r\\n ]*[=+\\-@]/");
        expect(csvBuilder).toContain("ORDER_CSV_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024");
        expect(csvBuilder).toContain("byteLength + chunkBytes > maxBytes");
        expect(csvBuilder).not.toContain("attemptKey");
        expect(csvBuilder).not.toContain("providerSessionId");
        expect(csvBuilder).not.toContain("providerCorrelationId");
        expect(csvBuilder).not.toContain("lastError");
    });

    it("serves the source-bounded printable invoice with attachment disposition", () => {
        const invoiceRoute = readFileSync(ADMIN_ORDERS_INVOICE_ROUTE_SOURCE, "utf8");

        expect(invoiceRoute).toContain("renderPrintableInvoice(document)");
        expect(invoiceRoute).toContain('"Content-Disposition": `attachment; filename=');
        expect(invoiceRoute).toContain('"Content-Length": String(artifactBytes)');
        expect(invoiceRoute).toContain('"X-Artifact-Bytes": String(artifactBytes)');
        expect(invoiceRoute).not.toContain('"Content-Disposition": `inline;');
    });

    it("declares payment recovery link issuance before the dynamic order route", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");
        const recoveryLinkRoute = source.split("const createPaymentRecoveryLinkRoute = createRoute")[1]?.split("// ─── GET /:id")[0] ?? "";

        expect(source.indexOf("const createPaymentRecoveryLinkRoute = createRoute"))
            .toBeLessThan(source.indexOf("const getOrderRoute = createRoute"));
        expect(recoveryLinkRoute).toContain('path: "/{id}/payment-recovery-link"');
        expect(recoveryLinkRoute).toContain('summary: "Issue a hosted-payment receipt recovery link"');
        expect(recoveryLinkRoute).toContain("OrdersService.previewOrderPaymentRecoveryLink");
        expect(recoveryLinkRoute).toContain("buildPaymentRecoveryUrl");
        expect(recoveryLinkRoute).toContain('accessMode: "buyer_verified_receipt"');
        expect(recoveryLinkRoute).not.toContain("receiptToken");
        expect(recoveryLinkRoute).not.toContain("tokenHash");
        expect(recoveryLinkRoute).not.toContain("writePaymentRecoveryReceiptHint");
        expect(recoveryLinkRoute).not.toContain("c.env.CACHE");
        expect(recoveryLinkRoute).not.toContain("ORDER_NOTIFICATIONS_QUEUE");
        expect(recoveryLinkRoute).not.toContain("createSSLCommerzPaymentSession");
        expect(recoveryLinkRoute).not.toContain("createPolarPaymentSession");
    });

    it("exposes sanitized payment-session attempt visibility on order payments", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");
        const attemptSchema = source.split("const paymentSessionAttemptSchema = z.object")[1]?.split("const getItemsRoute = createRoute")[0] ?? "";
        const paymentsRoute = source.split("const getPaymentsRoute = createRoute")[1] ?? "";

        expect(source).toContain("listOrderPaymentSessionAttempts");
        expect(paymentsRoute).toContain("paymentSessionAttempts: z.array(paymentSessionAttemptSchema)");
        expect(paymentsRoute).toContain("paymentSessionAttempts: paymentSessionAttemptViews");
        expect(attemptSchema).toContain("providerSessionId: z.string().nullable()");
        expect(attemptSchema).toContain("providerCorrelationId: z.string().nullable()");
        expect(attemptSchema).toContain("activeProcessing: z.boolean()");
        expect(attemptSchema).toContain("staleProcessing: z.boolean()");
        expect(attemptSchema).not.toContain("attemptKey");
        expect(attemptSchema).not.toContain("requestHash");
        expect(attemptSchema).not.toContain("responsePayload");
        expect(attemptSchema).not.toContain("claimId:");
        expect(paymentsRoute).not.toContain("attemptKey");
        expect(paymentsRoute).not.toContain("requestHash");
        expect(paymentsRoute).not.toContain("responsePayload");
        expect(paymentsRoute).not.toContain("claimId:");
    });
});
