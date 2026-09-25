// Order fulfilment actions on the ledger (Wave A §2.2): send a parcel with
// your own rider, hand a pickup order over at the counter, mark a service
// done, void a fulfilment whose parcel came back, and mark a pickup order
// ready to collect. Courier bookings stay on POST /{id}/shipments.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MANUAL_FULFILLMENT_TYPES } from "@scalius/shared/fulfilment";
import { ServiceUnavailableError } from "../../../utils/api-error";
import { successEnvelope, serviceUnavailableResponse } from "../../../schemas/responses";
import {
    fulfillmentTypeSchema,
    orderFulfilmentLineSchema,
} from "../../../schemas/order-lines";
import { adminOrderResourceMutationErrorResponses } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const requestKeySchema = z.string().uuid().openapi({
    description: "Retry key: repeating the request returns the first result instead of acting twice.",
});

const fulfilmentLinesInputSchema = z.array(z.object({
    itemId: z.string().min(1).max(180),
    quantity: z.number().int().min(1).max(99),
})).min(1).max(99).optional().openapi({
    description: "Which units to hand over; part of a line is fine. Omit for every unit of this kind not handed over yet.",
});

const fulfilmentTrackingInputSchema = z.object({
    courierName: z.string().trim().max(120).optional(),
    trackingId: z.string().trim().max(180).optional(),
    trackingUrl: z.string().trim().url("Enter a full link, starting with https://").optional(),
    note: z.string().trim().max(500).optional(),
    shipmentAmount: z.number().min(0, "The delivery cost can't be negative.").optional(),
}).strict().openapi({ description: "Own-rider parcel details; only for `ship`." });

const createFulfilmentBodySchema = z.object({
    requestKey: requestKeySchema,
    kind: z.enum(MANUAL_FULFILLMENT_TYPES).openapi({
        description: "`ship`: mark as sent with your own rider. `pickup`: the buyer collected it. `service`: the service was performed.",
    }),
    lines: fulfilmentLinesInputSchema,
    tracking: fulfilmentTrackingInputSchema.optional(),
    cashReceived: z.number().min(0).optional().openapi({
        description: "Cash on delivery taken at the counter or the service in the same action (`pickup`/`service`, major units). Must equal the balance due.",
    }),
}).strict();

const fulfilmentResultSchema = z.object({
    orderId: z.string(),
    fulfillmentId: z.string(),
    kind: fulfillmentTypeSchema,
    lines: z.array(orderFulfilmentLineSchema),
    /** The own-rider parcel created for a `ship` fulfilment. */
    shipmentId: z.string().nullable(),
    orderStatus: z.string(),
    fulfillmentStatus: z.string(),
    /** The same request key already recorded this fulfilment. */
    replayed: z.boolean(),
});

const createFulfilmentRoute = createRoute({
    operationId: "dashboard.orders.fulfillment_create",
    method: "post",
    path: "/{id}/fulfillments",
    tags: ["Admin - Orders"],
    summary: "Hand over order lines: send with your own rider, picked up at the counter, or service done",
    description: "The only way units are marked handed over. When the last line that blocks delivery is handed over and the money is settled, the order becomes delivered (pickup and service); the last ship line makes it shipped.",
    request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: createFulfilmentBodySchema } } },
    },
    responses: {
        201: {
            description: "Fulfilment recorded",
            content: { "application/json": { schema: successEnvelope(fulfilmentResultSchema) } },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(createFulfilmentRoute, async () => {
    throw new ServiceUnavailableError("Fulfilment actions are not available yet.");
});

const voidFulfilmentRoute = createRoute({
    operationId: "dashboard.orders.fulfillment_void",
    method: "post",
    path: "/{id}/fulfillments/{fulfillmentId}/void",
    tags: ["Admin - Orders"],
    summary: "Void an own-rider parcel that came back: its units go back on the unsent list",
    request: {
        params: z.object({ id: z.string(), fulfillmentId: z.string() }),
        body: {
            required: true,
            content: { "application/json": { schema: z.object({ requestKey: requestKeySchema }).strict() } },
        },
    },
    responses: {
        200: {
            description: "Fulfilment voided",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        orderId: z.string(),
                        fulfillmentId: z.string(),
                        /** Units put back on the unsent list. */
                        quantity: z.number().int(),
                        replayed: z.boolean(),
                    })),
                },
            },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(voidFulfilmentRoute, async () => {
    throw new ServiceUnavailableError("Fulfilment actions are not available yet.");
});

const pickupReadyRoute = createRoute({
    operationId: "dashboard.orders.pickup_ready",
    method: "post",
    path: "/{id}/pickup-ready",
    tags: ["Admin - Orders"],
    summary: "Mark a pickup order ready to collect and tell the buyer",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            required: true,
            content: { "application/json": { schema: z.object({ requestKey: requestKeySchema }).strict() } },
        },
    },
    responses: {
        200: {
            description: "Order marked ready for pickup",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        orderId: z.string(),
                        pickupReadyAt: z.string(),
                        replayed: z.boolean(),
                    })),
                },
            },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(pickupReadyRoute, async () => {
    throw new ServiceUnavailableError("Fulfilment actions are not available yet.");
});

export { app as adminOrderFulfilmentRoutes };
