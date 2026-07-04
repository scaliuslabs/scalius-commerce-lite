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
