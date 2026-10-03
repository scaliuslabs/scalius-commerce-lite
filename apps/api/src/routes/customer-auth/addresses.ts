// The signed-in buyer's address book (MARKETS-DESIGN D7). Every write follows
// the address country's rules (a buyer never skips them) and answers the whole
// book, the default first, so the hosted account page redirects without a
// second read.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    addressInputSchema,
    createCustomerAddress,
    deleteCustomerAddress,
    listCustomerAddresses,
    setDefaultCustomerAddress,
    updateCustomerAddress,
} from "@scalius/core/modules/customers";
import { customerAddressSchema } from "../../schemas/entities";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { UnauthorizedError } from "../../utils/api-error";
import { requireCustomerSession, setPrivateNoStoreHeaders } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const bookSchema = z.object({ addresses: z.array(customerAddressSchema) });
const bookResponses = {
    200: { description: "The address book, the default first", content: { "application/json": { schema: successEnvelope(bookSchema) } } },
    ...errorResponses,
};
const addressBodySchema = addressInputSchema.extend({ isDefault: z.boolean().optional() }).strict();
const addressPathSchema = z.object({ addressId: z.string().min(1).max(64) });

async function accountId(c: Parameters<typeof requireCustomerSession>[0]): Promise<string> {
    setPrivateNoStoreHeaders(c);
    const { session } = await requireCustomerSession(c);
    if (!session.customerId) throw new UnauthorizedError("Session expired. Please log in again.");
    return session.customerId;
}

const listRoute = createRoute({
    method: "get",
    path: "/addresses",
    operationId: "storefront.customer_auth_addresses.list",
    tags: ["Customer Auth"],
    summary: "List the account's addresses",
    responses: bookResponses,
});
app.openapi(listRoute, async (c) => {
    const customerId = await accountId(c);
    return ok(c, { addresses: await listCustomerAddresses(c.get("db"), customerId) });
});

const createAddressRoute = createRoute({
    method: "post",
    path: "/addresses",
    operationId: "storefront.customer_auth_addresses.create",
    tags: ["Customer Auth"],
    summary: "Add an address",
    description: "The first address becomes the default; `isDefault` makes a later one the default. A Bangladesh address sends its City/Thana/Area ids.",
    request: { body: { required: true, content: { "application/json": { schema: addressBodySchema } } } },
    responses: bookResponses,
});
app.openapi(createAddressRoute, async (c) => {
    const customerId = await accountId(c);
    const db = c.get("db");
    await createCustomerAddress(db, customerId, c.req.valid("json"));
    return ok(c, { addresses: await listCustomerAddresses(db, customerId) });
});

const updateAddressRoute = createRoute({
    method: "put",
    path: "/addresses/{addressId}",
    operationId: "storefront.customer_auth_addresses.update",
    tags: ["Customer Auth"],
    summary: "Change an address",
    request: {
        params: addressPathSchema,
        body: { required: true, content: { "application/json": { schema: addressBodySchema } } },
    },
    responses: bookResponses,
});
app.openapi(updateAddressRoute, async (c) => {
    const customerId = await accountId(c);
    const db = c.get("db");
    await updateCustomerAddress(db, customerId, c.req.valid("param").addressId, c.req.valid("json"));
    return ok(c, { addresses: await listCustomerAddresses(db, customerId) });
});

const setDefaultRoute = createRoute({
    method: "post",
    path: "/addresses/{addressId}/default",
    operationId: "storefront.customer_auth_addresses.set_default",
    tags: ["Customer Auth"],
    summary: "Make an address the default",
    request: { params: addressPathSchema },
    responses: bookResponses,
});
app.openapi(setDefaultRoute, async (c) => {
    const customerId = await accountId(c);
    const db = c.get("db");
    await setDefaultCustomerAddress(db, customerId, c.req.valid("param").addressId);
    return ok(c, { addresses: await listCustomerAddresses(db, customerId) });
});

const deleteAddressRoute = createRoute({
    method: "delete",
    path: "/addresses/{addressId}",
    operationId: "storefront.customer_auth_addresses.delete",
    tags: ["Customer Auth"],
    summary: "Delete an address",
    description: "When the default goes, the most recently changed other address becomes the default.",
    request: { params: addressPathSchema },
    responses: bookResponses,
});
app.openapi(deleteAddressRoute, async (c) => {
    const customerId = await accountId(c);
    const db = c.get("db");
    await deleteCustomerAddress(db, customerId, c.req.valid("param").addressId);
    return ok(c, { addresses: await listCustomerAddresses(db, customerId) });
});

export { app as customerAddressRoutes };
