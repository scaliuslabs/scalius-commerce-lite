// Disputes (chargebacks) on an order's payments (core payments/disputes.ts).
// A provider that reports disputes (Stripe's dispute webhooks) records them
// itself; staff record a chargeback by hand only on a payment whose gateway
// reports none, and decide its outcome. Evidence is answered in the
// provider's own dashboard (`dashboardUrl`), never here. Permissions:
// packages/core/src/auth/rbac/route-permissions/orders.ts.
import { createRoute, z } from "@hono/zod-openapi";
import {
    DISPUTE_FUNDS,
    DISPUTE_STATUSES,
    providerReportsDisputes,
    readDisputesAwaitingResponse,
    recordDisputeByHand,
    resolveDisputeByHand,
    type ApplyDisputeResult,
    type OrderDisputeView,
} from "@scalius/core/modules/payments";
import { buyerText } from "@scalius/shared/buyer-text";
import { minorMoney } from "@scalius/shared/money-field";
import { orderPayments } from "@scalius/database/schema";
import { and, eq } from "drizzle-orm";
import { adminRouter } from "../admin-router";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "../idempotency";
import { requireStaffId } from "../request-actor";
import { requestPaymentProviders } from "../../../plugins/providers/payment";
import { NotFoundError, ValidationError } from "../../../utils/api-error";
import { ok } from "../../../utils/api-response";
import { successEnvelope } from "../../../schemas/responses";
import { isoTimestampSchema, nullableIsoTimestampSchema } from "../../../schemas/timestamps";
import { adminOrderResourceMutationErrorResponses } from "./shared";
import { notificationSender } from "../../../background/notification-sender";

const app = adminRouter();

/** One dispute on the order's payment panel. Amounts are integer minor units of their own currency. */
export const orderDisputeSchema = z.object({
    id: z.string(),
    paymentId: z.string(),
    gateway: z.string(),
    status: z.enum(DISPUTE_STATUSES),
    funds: z.enum(DISPUTE_FUNDS).openapi({ description: "held: the store still has the money; withdrawn: the bank took it; reinstated: it came back." }),
    amountMinor: minorMoney(z.number().int(), "named"),
    currency: z.string(),
    /** The card network's or provider's reason; a staff note for a hand-recorded one. */
    reason: buyerText(z.string().nullable()),
    /** What the buyer told their bank, when the provider passes it on. */
    buyerMessage: buyerText(z.string().nullable()),
    evidenceDueAt: nullableIsoTimestampSchema,
    feeMinor: minorMoney(z.number().int().nullable(), "named").openapi({ description: "The provider's dispute fee in feeCurrency: information, never buyer money." }),
    feeCurrency: z.string().nullable(),
    dashboardUrl: z.string().nullable().openapi({ description: "Where staff answer the dispute at its provider." }),
    byHand: z.boolean().openapi({ description: "Recorded by hand: staff decide its outcome. A provider's dispute is decided by its events." }),
    recordedBy: z.string().nullable(),
    createdAt: isoTimestampSchema,
    closedAt: nullableIsoTimestampSchema,
});

export function presentOrderDispute(dispute: OrderDisputeView): z.infer<typeof orderDisputeSchema> {
    return {
        ...dispute,
        evidenceDueAt: dispute.evidenceDueAt?.toISOString() ?? null,
        createdAt: dispute.createdAt.toISOString(),
        closedAt: dispute.closedAt?.toISOString() ?? null,
    };
}

const disputeResultSchema = successEnvelope(z.object({
    disputeId: z.string(),
    /** `unchanged`: a repeat of what was already recorded. */
    outcome: z.enum(["applied", "unchanged"]),
    status: z.enum(DISPUTE_STATUSES),
    funds: z.enum(DISPUTE_FUNDS),
    paidAmountMinor: minorMoney(z.number().int(), "order"),
}));

function disputeResult(result: ApplyDisputeResult) {
    return {
        disputeId: result.disputeId,
        outcome: result.outcome,
        status: result.state.status,
        funds: result.state.funds,
        paidAmountMinor: result.paidAmountMinor,
    };
}

// ─── GET /disputes/summary ───────────────────────────────────────────────────

app.openapi(createRoute({
    operationId: "dashboard.orders.disputes_summary",
    method: "get",
    path: "/disputes/summary",
    tags: ["Admin - Orders"],
    summary: "Disputes waiting for the store's answer",
    description: "How many disputes wait for the store's answer and the nearest evidence deadline among them (Home's to-do). The orders list's `disputes` view lists the orders.",
    responses: {
        200: {
            description: "Disputes awaiting a response",
            content: { "application/json": { schema: successEnvelope(z.object({
                awaitingResponse: z.number().int().min(0),
                nextEvidenceDueAt: nullableIsoTimestampSchema,
            })) } },
        },
        401: adminOrderResourceMutationErrorResponses[401],
        403: adminOrderResourceMutationErrorResponses[403],
    },
}), async (c) => {
    const summary = await readDisputesAwaitingResponse(c.get("db"));
    return ok(c, { awaitingResponse: summary.count, nextEvidenceDueAt: summary.nextEvidenceDueAt?.toISOString() ?? null });
});

// ─── POST /:id/payments/:paymentId/disputes ──────────────────────────────────

const recordDisputeRoute = createRoute({
    operationId: "dashboard.orders.dispute_record",
    method: "post",
    path: "/{id}/payments/{paymentId}/disputes",
    tags: ["Admin - Orders"],
    summary: "Record a chargeback by hand on a payment",
    description: "For a payment whose gateway reports no disputes itself (cash on delivery, a bank transfer, a regional wallet): the buyer's bank took back, or asks to take back, part or all of it. The disputed amount comes off what the order was paid while it is withdrawn; refunds drawing on the payment wait while the dispute is open. Stock and fulfilment are not touched. Refused for a gateway that reports disputes (Stripe).",
    request: {
        params: z.object({ id: z.string(), paymentId: z.string() }),
        headers: idempotencyKeyHeaderSchema,
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        amountMinor: minorMoney(z.number().int().positive(), "order").openapi({ description: "What the buyer disputes, at most the payment." }),
                        reason: z.string().trim().min(1).max(300),
                        fundsWithdrawn: z.boolean().openapi({ description: "The bank or provider already took the money." }),
                        lost: z.boolean().optional().openapi({ description: "Already decided against the store: final, the money stays taken." }),
                        evidenceDueAt: isoTimestampSchema.optional().openapi({ description: "The last day to answer, if the bank gave one." }),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: { description: "The dispute", content: { "application/json": { schema: disputeResultSchema } } },
        ...adminOrderResourceMutationErrorResponses,
    },
});

app.openapi(recordDisputeRoute, async (c) => {
    const { id, paymentId } = c.req.valid("param");
    const data = c.req.valid("json");
    const db = c.get("db");
    const recordedBy = requireStaffId(c, "Sign in again to record a chargeback.");
    // One key, one chargeback: a repeat returns the first instead of recording a second.
    const key = c.req.valid("header")["idempotency-key"];
    if (!key) throw new ValidationError("The Idempotency-Key header is required.");
    const requestKey = await scopedRequestKey(c, "dashboard.orders.dispute_record", key);
    const payment = await db.select({ paymentMethod: orderPayments.paymentMethod }).from(orderPayments)
        .where(and(eq(orderPayments.id, paymentId), eq(orderPayments.orderId, id))).get();
    if (!payment) throw new NotFoundError("Payment not found");
    const result = await recordDisputeByHand(db, {
        orderId: id,
        paymentId,
        amountMinor: data.amountMinor,
        reason: data.reason,
        fundsWithdrawn: data.fundsWithdrawn,
        lost: data.lost === true,
        evidenceDueAt: data.evidenceDueAt ? new Date(data.evidenceDueAt) : null,
        recordedBy,
        requestKey,
        providerReportsDisputes: await providerReportsDisputes(() => requestPaymentProviders(c), payment.paymentMethod),
    });
    if (result.notificationOutboxId) await notificationSender(c)([result.notificationOutboxId]);
    return ok(c, disputeResult(result));
});

// ─── POST /:id/disputes/:disputeId/outcome ───────────────────────────────────

const resolveDisputeRoute = createRoute({
    operationId: "dashboard.orders.dispute_resolve",
    method: "post",
    path: "/{id}/disputes/{disputeId}/outcome",
    tags: ["Admin - Orders"],
    summary: "Record the outcome of a chargeback recorded by hand",
    description: "`won` gives the withdrawn money back to what the order was paid; `lost` keeps it taken for good. A provider's dispute is decided by its provider's events and is refused here. Repeating the same outcome changes nothing.",
    request: {
        params: z.object({ id: z.string(), disputeId: z.string() }),
        body: {
            required: true,
            content: { "application/json": { schema: z.object({ outcome: z.enum(["won", "lost"]) }).strict() } },
        },
    },
    responses: {
        200: { description: "The dispute", content: { "application/json": { schema: disputeResultSchema } } },
        ...adminOrderResourceMutationErrorResponses,
    },
});

app.openapi(resolveDisputeRoute, async (c) => {
    const { id, disputeId } = c.req.valid("param");
    const recordedBy = requireStaffId(c, "Sign in again to record the dispute's outcome.");
    const result = await resolveDisputeByHand(c.get("db"), {
        orderId: id,
        disputeId,
        outcome: c.req.valid("json").outcome,
        recordedBy,
    });
    return ok(c, disputeResult(result));
});

export { app as adminOrderDisputeRoutes };
