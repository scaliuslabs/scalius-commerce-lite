// The signed-in buyer's marketing preferences (Customers & marketing).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getAccountMarketingPreferences,
    updateAccountMarketingPreferences,
} from "@scalius/core/modules/customer-marketing";
import { MARKETING_CHANNELS, MARKETING_CONSENT_STATUSES } from "@scalius/shared/customer-marketing";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { UnauthorizedError } from "../../utils/api-error";
import { requireCustomerSession } from "./shared";
import { notificationSender } from "../../background/notification-sender";

const app = new OpenAPIHono<{ Bindings: Env }>();

const preferencesSchema = z.object({
    channels: z.array(z.object({
        channel: z.enum(MARKETING_CHANNELS),
        status: z.enum(MARKETING_CONSENT_STATUSES),
        /** The account has an address for this channel. */
        available: z.boolean(),
    })),
});

async function accountId(c: Parameters<typeof requireCustomerSession>[0]): Promise<string> {
    const { session } = await requireCustomerSession(c);
    if (!session.customerId) throw new UnauthorizedError("Session expired. Please log in again.");
    return session.customerId;
}

const getRoute = createRoute({
    method: "get",
    path: "/marketing",
    operationId: "storefront.customer_auth_marketing.get",
    tags: ["Customer Auth"],
    summary: "Get the account's marketing preferences",
    responses: {
        200: { description: "Marketing preferences", content: { "application/json": { schema: successEnvelope(preferencesSchema) } } },
        ...errorResponses,
    },
});

app.openapi(getRoute, async (c) => {
    return ok(c, await getAccountMarketingPreferences(c.get("db"), await accountId(c)));
});

const updateRoute = createRoute({
    method: "put",
    path: "/marketing",
    operationId: "storefront.customer_auth_marketing.update",
    tags: ["Customer Auth"],
    summary: "Change the account's marketing preferences",
    description: "Turns channels on or off. An unverified e-mail waits for its confirmation link when double opt-in is on.",
    request: {
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        email: z.boolean().optional(),
                        sms: z.boolean().optional(),
                        whatsapp: z.boolean().optional(),
                        push: z.boolean().optional(),
                        /** Storefront language, for the consent text recorded. */
                        language: z.string().max(16).optional(),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Preferences saved",
            content: { "application/json": { schema: successEnvelope(preferencesSchema.extend({ confirmationRequested: z.boolean() })) } },
        },
        ...errorResponses,
    },
});

app.openapi(updateRoute, async (c) => {
    const customerId = await accountId(c);
    const result = await updateAccountMarketingPreferences(c.get("db"), customerId, c.req.valid("json"), {
        env: c.env as never,
        send: notificationSender(c),
    });
    return ok(c, result);
});

export { app as customerMarketingRoutes };
