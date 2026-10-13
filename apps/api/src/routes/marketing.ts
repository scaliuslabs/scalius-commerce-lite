// Storefront marketing routes (Customers & marketing), called by the
// storefront Worker only (system JWT): the newsletter signup, the e-mail
// double opt-in confirmation and the signed unsubscribe link. Tokens travel
// in POST bodies here (the storefront page reads them from the e-mail link);
// responses never say whether a contact or customer exists.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    confirmMarketingOptIn,
    describeUnsubscribeLink,
    subscribeToNewsletter,
    unsubscribeWithLink,
    verifyUnsubscribeToken,
} from "@scalius/core/modules/customer-marketing";
import {
    MARKETING_CHANNELS,
    MARKETING_CONSENT_STATUSES,
    newsletterSubscribeSchema,
} from "@scalius/shared/customer-marketing";
import { authMiddleware } from "../middleware/auth";
import { errorResponses, successEnvelope } from "../schemas/responses";
import { ok } from "../utils/api-response";
import { RateLimitError } from "../utils/api-error";
import { getTrustedClientIp } from "../utils/client-ip";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { isWithinRateLimit } from "../utils/rate-limit";
import { notificationSender } from "../background/notification-sender";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", authMiddleware);

async function limitLinks(env: Env, ip: string): Promise<void> {
    if (!(await isWithinRateLimit(env, "RL_STANDARD", "marketing-link-ip", ip))) {
        throw new RateLimitError("Too many requests. Try again in a minute.", 60);
    }
}

const tokenBody = z.object({ token: z.string().min(1).max(400) }).strict();

// ── POST /subscribe ──

const subscribeRoute = createRoute({
    method: "post",
    path: "/subscribe",
    operationId: "storefront.marketing.subscribe",
    tags: ["Marketing"],
    summary: "Subscribe to the newsletter",
    description: "Files the phone (and optional e-mail) under a customer record and records SMS (and WhatsApp, e-mail) marketing consent. E-mail waits for its confirmation link when double opt-in is on.",
    request: { body: { required: true, content: { "application/json": { schema: newsletterSubscribeSchema } } } },
    responses: {
        200: {
            description: "Signup recorded (or a confirmation e-mail is on its way)",
            content: { "application/json": { schema: successEnvelope(z.object({ result: z.enum(["subscribed", "pending"]) })) } },
        },
        ...errorResponses,
    },
});

app.openapi(subscribeRoute, async (c) => {
    const ip = getTrustedClientIp(c);
    if (!(await isWithinRateLimit(c.env, "RL_STRICT", "newsletter-ip", ip))) {
        throw new RateLimitError("Too many signups. Try again in a minute.", 60);
    }
    const result = await subscribeToNewsletter(c.get("db"), c.req.valid("json"), {
        env: c.env as never,
        send: notificationSender(c),
        ip,
        rateLimitKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    });
    return ok(c, result);
});

// ── POST /confirm ──

const confirmRoute = createRoute({
    method: "post",
    path: "/confirm",
    operationId: "storefront.marketing.confirm",
    tags: ["Marketing"],
    summary: "Confirm an e-mail subscription",
    description: "Uses the single-use confirmation token from the double opt-in e-mail. Unknown, used, replaced and expired tokens all read invalid.",
    request: { body: { required: true, content: { "application/json": { schema: tokenBody } } } },
    responses: {
        200: {
            description: "Confirmation outcome",
            content: { "application/json": { schema: successEnvelope(z.object({ status: z.enum(["confirmed", "invalid"]) })) } },
        },
        ...errorResponses,
    },
});

app.openapi(confirmRoute, async (c) => {
    await limitLinks(c.env, getTrustedClientIp(c));
    const { status } = await confirmMarketingOptIn(c.get("db"), c.req.valid("json").token);
    return ok(c, { status });
});

// ── POST /unsubscribe/preview ──

const unsubscribePreviewRoute = createRoute({
    method: "post",
    path: "/unsubscribe/preview",
    operationId: "storefront.marketing.unsubscribe_preview",
    tags: ["Marketing"],
    summary: "Describe an unsubscribe link",
    description: "The channel and a masked address a valid signed unsubscribe link covers, for the confirmation page. Changes nothing.",
    request: { body: { required: true, content: { "application/json": { schema: tokenBody } } } },
    responses: {
        200: {
            description: "What the link unsubscribes",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        valid: z.boolean(),
                        channel: z.enum(MARKETING_CHANNELS).nullable(),
                        status: z.enum(MARKETING_CONSENT_STATUSES).nullable(),
                        contactMasked: z.string().nullable(),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(unsubscribePreviewRoute, async (c) => {
    await limitLinks(c.env, getTrustedClientIp(c));
    const link = await verifyUnsubscribeToken(c.env as never, c.req.valid("json").token);
    if (!link) return ok(c, { valid: false, channel: null, status: null, contactMasked: null });
    const view = await describeUnsubscribeLink(c.get("db"), link);
    return ok(c, { valid: true, channel: view.channel, status: view.status, contactMasked: view.contactMasked });
});

// ── POST /unsubscribe ──

const unsubscribeRoute = createRoute({
    method: "post",
    path: "/unsubscribe",
    operationId: "storefront.marketing.unsubscribe",
    tags: ["Marketing"],
    summary: "Unsubscribe with a signed link",
    description: "Turns off the channel a signed unsubscribe link names (RFC 8058 one-click and the unsubscribe page). Idempotent.",
    request: { body: { required: true, content: { "application/json": { schema: tokenBody } } } },
    responses: {
        200: {
            description: "Unsubscribe outcome",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        status: z.enum(["unsubscribed", "invalid"]),
                        channel: z.enum(MARKETING_CHANNELS).nullable(),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(unsubscribeRoute, async (c) => {
    await limitLinks(c.env, getTrustedClientIp(c));
    const link = await verifyUnsubscribeToken(c.env as never, c.req.valid("json").token);
    if (!link) return ok(c, { status: "invalid" as const, channel: null });
    await unsubscribeWithLink(c.get("db"), link);
    return ok(c, { status: "unsubscribed" as const, channel: link.channel });
});

export { app as marketingRoutes };
