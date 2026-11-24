// A line's delivery message on the staff order (rules/orders/buyer-line-delivery-message.md):
// one operation writes, replaces or removes it under its revision, and one
// reveals it to staff who may write it. Both need the digital-access
// permission (route-permissions/digital.ts) and are dashboard-only: the text
// is a buyer's sign-in in the clear, so it never passes through agent I/O
// (operation-registry/dashboard-digital.ts). Answers are never cached; the
// order's `extras.message` names a message by id and revision, never its text.
import { createRoute, z } from "@hono/zod-openapi";
import { revealStaffOrderLineMessage, setOrderLineMessage, type StaffOrderLineMessage } from "@scalius/core/modules/fulfilment";
import { ORDER_LINE_MESSAGE_LINK_MAX, ORDER_LINE_MESSAGE_TEXT_MAX } from "@scalius/shared/order-line-message";
import { adminRouter } from "../admin-router";
import { characterText } from "../../../schemas/text";
import { ok } from "../../../utils/api-response";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../../schemas/responses";
import { requestActorId } from "../request-actor";

const app = adminRouter();

const params = z.object({
    id: z.string().min(1).max(80),
    itemId: z.string().min(1).max(80),
});

const staffMessageSchema = z.object({
    id: z.string(),
    orderItemId: z.string().openapi({ description: "The line it is stored on: a split kit item's two lines share their first line's message." }),
    revision: z.number().int().positive(),
    hasLink: z.boolean(),
    updatedAt: z.string().openapi({ format: "date-time" }),
});

function present(message: StaffOrderLineMessage) {
    return { ...message, updatedAt: new Date(message.updatedAt * 1000).toISOString() };
}

app.openapi(createRoute({
    method: "put",
    path: "/{id}/items/{itemId}/delivery-message",
    operationId: "dashboard.orders.line_message_set",
    tags: ["Admin - Orders"],
    summary: "Write, replace or remove a line's delivery message",
    description: `Sets what the buyer of this line reads in their account (an account's sign-in, an instruction) and an optional https link, or removes it with \`message: null\`. Plain text of 1 to ${ORDER_LINE_MESSAGE_TEXT_MAX} characters, drawn as text, never HTML; the link is a full https:// address of at most ${ORDER_LINE_MESSAGE_LINK_MAX} characters. Both are stored encrypted. Name the message's \`revision\` from the order (\`items[].extras.message.revision\`), or 0 when the line has none: a stale one is refused with 409 \`line_message_revision_conflict\` (\`details.revision\` is the current one) and nothing changes. A split kit item's lines share one message. The buyer sees it once the order is paid; the order timeline records the change, never the text.`,
    request: {
        params,
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        message: z.object({
                            text: characterText(ORDER_LINE_MESSAGE_TEXT_MAX).openapi({ description: "Plain text; line breaks are kept." }),
                            link: z.string().max(ORDER_LINE_MESSAGE_LINK_MAX).nullable().optional().openapi({ description: "An https:// address, or null for none." }),
                        }).strict().nullable().openapi({ description: "The message, or null to remove it." }),
                        expectedRevision: z.number().int().min(0).openapi({ description: "The message's revision you read; 0 when the line has none." }),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "The message as staff see it (null once removed)",
            content: { "application/json": { schema: successEnvelope(z.object({ message: staffMessageSchema.nullable(), changed: z.boolean() })) } },
        },
        ...errorResponses,
        409: { ...conflictResponse, description: "line_message_revision_conflict: the message changed since it was read" },
        503: serviceUnavailableResponse,
    },
}), async (c) => {
    c.header("Cache-Control", "private, no-store");
    const { id, itemId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await setOrderLineMessage(c.get("db"), getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>), {
        orderId: id,
        orderItemId: itemId,
        message: body.message,
        expectedRevision: body.expectedRevision,
        actorId: requestActorId(c),
    });
    return ok(c, { message: result.message ? present(result.message) : null, changed: result.changed });
});

app.openapi(createRoute({
    method: "post",
    path: "/{id}/items/{itemId}/delivery-message/reveal",
    operationId: "dashboard.orders.line_message_reveal",
    tags: ["Admin - Orders"],
    summary: "Show a line's delivery message to edit it",
    description: "The text and link of the line's delivery message, for staff who may write it. Never cached; the order timeline records who read it, never the text.",
    request: { params },
    responses: {
        200: {
            description: "The message",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        message: staffMessageSchema,
                        text: z.string(),
                        link: z.string().nullable(),
                    })),
                },
            },
        },
        ...errorResponses,
        503: serviceUnavailableResponse,
    },
}), async (c) => {
    c.header("Cache-Control", "private, no-store");
    const { id, itemId } = c.req.valid("param");
    const revealed = await revealStaffOrderLineMessage(c.get("db"), getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>), {
        orderId: id,
        orderItemId: itemId,
        actorId: requestActorId(c),
    });
    return ok(c, { message: present(revealed.message), text: revealed.text, link: revealed.link });
});

export { app as adminOrderLineMessageRoutes };
