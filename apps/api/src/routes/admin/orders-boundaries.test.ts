import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ADMIN_ORDERS_ROUTE_SOURCE = fileURLToPath(
    new URL("./orders.ts", import.meta.url),
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

    it("keeps hosted-payment recovery queue and export sanitized", () => {
        const source = readFileSync(ADMIN_ORDERS_ROUTE_SOURCE, "utf8");
        const recoveryListRoute = source.split("const paymentRecoveryListRoute = createRoute")[1]?.split("const paymentRecoveryExportRoute = createRoute")[0] ?? "";
        const recoveryExportRoute = source.split("const paymentRecoveryExportRoute = createRoute")[1]?.split("// ─── POST / (Create)")[0] ?? "";
        const csvBuilder = source.split("function buildPaymentRecoveryCsv")[1]?.split("function isSuccessfulOrderResult")[0] ?? "";

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
        expect(recoveryExportRoute).toContain('"X-Export-Row-Count"');
        expect(recoveryExportRoute).toContain('"X-Export-Limited"');
        expect(recoveryExportRoute).toContain("paymentRecovery: query.state as OrderPaymentRecoveryFilter");

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
