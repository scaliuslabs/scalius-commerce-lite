// The signed-in buyer's saved payment methods (security audit N3): the cards
// or wallets a provider kept for later charges without them (a subscription's
// renewals), each with what it was kept for. The buyer sees only their own
// and can remove one: the provider detaches it first, then nothing can
// charge it again. Answers the remaining list, so the hosted account page
// redirects without a second read.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { listCustomerPaymentMethods, removeCustomerPaymentMethod } from "@scalius/core/modules/payments";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { customerSavedPaymentMethod, customerSavedPaymentMethodSchema } from "../../schemas/saved-payment-methods";
import { ok } from "../../utils/api-response";
import { UnauthorizedError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { requestPaymentProviders } from "../../plugins/providers/payment";
import { requireCustomerSession, setPrivateNoStoreHeaders } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const listSchema = z.object({ paymentMethods: z.array(customerSavedPaymentMethodSchema) });
const listResponses = {
    200: { description: "The account's saved payment methods, oldest first", content: { "application/json": { schema: successEnvelope(listSchema) } } },
    ...errorResponses,
};

async function accountId(c: Parameters<typeof requireCustomerSession>[0]): Promise<string> {
    setPrivateNoStoreHeaders(c);
    const { session } = await requireCustomerSession(c);
    if (!session.customerId) throw new UnauthorizedError("Session expired. Please log in again.");
    return session.customerId;
}

async function listFor(c: Parameters<typeof requireCustomerSession>[0], customerId: string) {
    const methods = await listCustomerPaymentMethods(c.get("db"), customerId, { kind: "customer", customerId });
    return { paymentMethods: methods.map(customerSavedPaymentMethod) };
}

app.openapi(createRoute({
    method: "get",
    path: "/payment-methods",
    operationId: "storefront.customer_auth_payment_methods.list",
    tags: ["Customer Auth"],
    summary: "List the account's saved payment methods",
    description: "Cards or wallets kept by a payment provider for charges without the buyer (a subscription's renewals): brand, last four digits, expiry and what each was kept for. Never a card number.",
    responses: listResponses,
}), async (c) => {
    const customerId = await accountId(c);
    return ok(c, await listFor(c, customerId));
});

app.openapi(createRoute({
    method: "delete",
    path: "/payment-methods/{methodId}",
    operationId: "storefront.customer_auth_payment_methods.delete",
    tags: ["Customer Auth"],
    summary: "Remove a saved payment method",
    description: "Detaches the method at its provider, then removes it: nothing can charge it again (a subscription that used it must be paid another way). Removing one already removed changes nothing.",
    request: { params: z.object({ methodId: z.string().min(1).max(128) }) },
    responses: listResponses,
}), async (c) => {
    const customerId = await accountId(c);
    await removeCustomerPaymentMethod(c.get("db"), {
        methodId: c.req.valid("param").methodId,
        actor: { kind: "customer", customerId },
        providers: () => requestPaymentProviders(c),
        encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    });
    return ok(c, await listFor(c, customerId));
});

export { app as customerPaymentMethodRoutes };
