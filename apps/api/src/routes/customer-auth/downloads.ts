// Signed-in buyer downloads and licence keys (Wave B design §3.4, §7.1):
// everything the account's orders delivered, a download ticket bound to the
// session token, and a licence-key reveal. Private, never cached.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { listBuyerDownloads, mintDownloadTicket, revealLicenceKey } from "@scalius/core/modules/digital";
import { ok } from "../../utils/api-response";
import { UnauthorizedError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import {
    buyerDigitalLineSchema,
    downloadTicketResponses,
    enforceDigitalBuyerLimit,
    presentBuyerDigitalLines,
    presentDownloadTicket,
    revealResponses,
    setNoStore,
} from "../storefront-orders/downloads";
import { requireCustomerSession } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

async function customerAccess(c: Parameters<typeof requireCustomerSession>[0]) {
    const { session, token } = await requireCustomerSession(c);
    if (!session.customerId) throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
    return { access: { kind: "customer" as const, customerId: session.customerId }, proof: token };
}

app.openapi(createRoute({
    method: "get",
    path: "/downloads",
    tags: ["Customer Auth"],
    summary: "Downloads and licence keys from the account's orders, newest first",
    responses: {
        200: { description: "Delivered items", content: { "application/json": { schema: successEnvelope(z.object({ lines: z.array(buyerDigitalLineSchema) })) } } },
        ...errorResponses,
    },
}), async (c) => {
    setNoStore(c);
    const { access } = await customerAccess(c);
    return ok(c, { lines: presentBuyerDigitalLines(await listBuyerDownloads(c.get("db"), access)) });
});

app.openapi(createRoute({
    method: "post",
    path: "/downloads/{entitlementId}/ticket",
    tags: ["Customer Auth"],
    summary: "Count one download of a file and get its short-lived, cookie-bound link",
    request: { params: z.object({ entitlementId: z.string().min(1).max(80) }) },
    responses: downloadTicketResponses,
}), async (c) => {
    setNoStore(c);
    await enforceDigitalBuyerLimit(c, "download_ticket");
    const { access, proof } = await customerAccess(c);
    const ticket = await mintDownloadTicket(c.get("db"), c.env, { entitlementId: c.req.valid("param").entitlementId, access, proof });
    return ok(c, presentDownloadTicket(ticket, access));
});

app.openapi(createRoute({
    method: "post",
    path: "/licence-keys/{keyId}/reveal",
    tags: ["Customer Auth"],
    summary: "Show one licence key from the account's orders",
    request: { params: z.object({ keyId: z.string().min(1).max(80) }) },
    responses: revealResponses,
}), async (c) => {
    setNoStore(c);
    await enforceDigitalBuyerLimit(c, "licence_key_reveal");
    const { access } = await customerAccess(c);
    return ok(c, await revealLicenceKey(c.get("db"), getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>), {
        keyId: c.req.valid("param").keyId,
        access,
    }));
});

export { app as customerDownloadRoutes };
