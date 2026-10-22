// src/server/routes/admin/customers.ts
// Admin OpenAPI routes for customers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { assertContactSearchAllowed } from "./contact-access";
import { protectedField as pii } from "../../schemas/protected";
import {
    listCustomers,
    createCustomer,
    createCustomerSchema,
    getCustomerDetail,
    updateCustomer,
    updateCustomerSchema,
    deleteCustomer,
    permanentlyDeleteCustomer,
    eraseCustomer,
    restoreCustomer,
    bulkDeleteCustomers,
    bulkRestoreCustomers,
    buildCustomerOrderMetricsProjection,
    customerKind,
    latestOrderNameSql,
    paidSpendAmount,
    createCustomerAddress,
    customerAddressInputSchema,
    deleteCustomerAddress,
    listCustomerAddresses,
    setDefaultBillingCustomerAddress,
    setDefaultCustomerAddress,
    updateCustomerAddress,
} from "@scalius/core/modules/customers";
import { fromMinor } from "@scalius/shared/money";
import { contactPhoneSql, customers, customerHistory, orders, user } from "@scalius/database/schema";
import { phoneOrNull } from "@scalius/shared/customer-auth-policy";
import { eq, sql, isNull, isNotNull, and } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { ForbiddenError, NotFoundError } from "../../utils/api-error";
import { customerListFilterQuery, customerListFiltersFromQuery, customerMatchingSchema, readCustomerSlice } from "./customer-marketing";
import { matchingResultSchema, requireOneSelection, type MatchingResult } from "../../schemas/bulk-matching";
import { planLimits } from "@scalius/shared/plan-limits";
import { appListQuerySchema, appListValuesSchema, planAppList } from "../../plugins/list-columns";

import { ok, created, noContent } from "../../utils/api-response";
import { successEnvelope, keysetPaginatedEnvelope, keysetQuerySchema, noContentResponse, errorResponses } from "../../schemas/responses";
import { customerAddressSchema, customerSummarySchema, customerDetailSchema } from "../../schemas/entities";
import { relatedObjectsProjection, withRelatedObjects } from "./related-objects";
import { relatedObjectRecordSchema } from "../../schemas/related-objects";
import { postalAddressInputSchema, type PostalAddressInput } from "../../schemas/postal-address";
import { customerEnvelope, readCustomerResource } from "./customer-resource";
import { staffSavedPaymentMethod, staffSavedPaymentMethodSchema } from "../../schemas/saved-payment-methods";
import { listCustomerPaymentMethods, removeCustomerPaymentMethod } from "@scalius/core/modules/payments";
import { requestPaymentProviders } from "../../plugins/providers/payment";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { timestampSchema, nullableTimestampSchema, optionalNullableTimestampSchema } from "../../schemas/timestamps";
const app = new OpenAPIHono<{ Bindings: Env }>();

/** The signed-in staff member, recorded as the author of customer changes. */
const staffId = (c: { get: (key: "user") => unknown }) => (c.get("user") as { id?: string } | undefined)?.id ?? null;

// ── List Customers ──

const listRoute = createRoute({
    operationId: "dashboard.customers.list",
    method: "get",
    path: "/",
    tags: ["Admin - Customers"],
    summary: "List all customers",
    description: "Find recent or new customers and search bounded customer summaries.",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number; reaches the first 1,000 rows only, 10,000 on a Paid deployment (page_too_deep beyond), use after/before to go deeper" }),
            limit: z.coerce.number().max(100).default(10).openapi({ description: "Items per page" }),
            ...keysetQuerySchema,
            search: z.string().optional().default("").openapi({ description: "Search term" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" }),
            ...customerListFilterQuery,
            ...appListQuerySchema,
        })
    },
    responses: {
        200: { description: "Cursor-paginated customer list with a capped total", content: { "application/json": { schema: keysetPaginatedEnvelope("customers", customerSummarySchema, { appValues: appListValuesSchema }) } } },
        ...errorResponses,
    }
});

const customerHistoryEntrySchema = z.object({
    id: z.string(),
    name: pii("name", z.string()),
    email: pii("email", z.string().nullable()),
    phone: pii("phone", z.string().nullable()),
    changeType: z.string().openapi({
        description: "created, updated, deleted, restored, signed_up, order_linked, order_moved_in / order_moved_out, or erased (see `order`, `relatedCustomer` and `verifiedContact`)",
    }),
    /** The proven contact behind signed_up / order_linked / order_moved_*. */
    verifiedContact: z.enum(["email", "phone"]).nullable(),
    /** Who made the change; `name` is the staff member's name when known. */
    author: z.object({
        kind: z.enum(["staff", "buyer", "system"]),
        name: z.string().nullable(),
    }).nullable(),
    /** The order that moved, for order_moved_in / order_moved_out. */
    order: z.object({ id: z.string(), orderNumber: z.number().int().nullable() }).nullable(),
    /** The other record in the move: the guest record it came from, or the account it went to. */
    relatedCustomer: z.object({
        id: z.string(),
        name: pii("name", z.string()),
        phone: pii("phone", z.string().nullable()),
        kind: z.enum(["account", "guest", "merchant"]),
    }).nullable(),
    createdAt: timestampSchema,
});

const customerLinkSchema = z.object({ id: z.string(), name: z.string() });

const customerHistoryOrderSchema = z.object({
    id: z.string(),
    orderNumber: z.number().int().nullable(),
    /** The name the order was placed with (a guest record can hold several people's orders). */
    customerName: pii("name", z.string()),
    totalAmount: z.number(),
    status: z.string(),
    createdAt: timestampSchema,
});

const customerHistoryCustomerSchema = customerDetailSchema.omit({ tags: true, marketing: true, addresses: true, taxExempt: true, taxExemptionId: true }).extend({
    lastOrderAt: nullableTimestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: optionalNullableTimestampSchema,
    /** Other active customers with the same phone (shared or family phones); links only, never a merge. */
    samePhone: z.array(customerLinkSchema.extend({
        name: pii("name", z.string()),
        phone: pii("phone", z.string()),
        kind: z.enum(["account", "guest", "merchant"]),
    })),
});

const customerHistoryPayloadSchema = z.object({
    customer: customerHistoryCustomerSchema,
    history: z.array(customerHistoryEntrySchema),
    orders: z.array(customerHistoryOrderSchema),
    pagination: z.object({
        history: z.object({
            page: z.number(),
            limit: z.number(),
            total: z.number(),
            totalPages: z.number(),
            hasNextPage: z.boolean(),
        }),
        orders: z.object({
            page: z.number(),
            limit: z.number(),
            total: z.number(),
            totalPages: z.number(),
            hasNextPage: z.boolean(),
        }),
    }),
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const q = c.req.valid("query");
    assertContactSearchAllowed(c, "search", q.search);
    // App columns and filters: nothing more is read unless the request names some.
    const appList = await planAppList(db, "customer", customers.id, q);
    const result = await listCustomers(db, {
        appCondition: appList.condition,
        page: q.page,
        limit: q.limit,
        after: q.after,
        before: q.before,
        search: q.search || "",
        showTrashed: q.trashed === "true",
        sort: q.sort as "name" | "totalOrders" | "totalSpent" | "lastOrderAt" | "createdAt" | "updatedAt" | undefined,
        order: q.order as "asc" | "desc" | undefined,
        filters: await customerListFiltersFromQuery(db, q),
    });
    const appValues = await appList.values(result.customers.map((customer) => customer.id));
    return ok(c, { ...result, ...(appValues ? { appValues } : {}) });
});

// ── Create Customer ──

// The first address is the one postal address shape (schemas/postal-address.ts):
// the store's delivery place ids only under `placeIds`.
const createCustomerBody = z.object({
    name: createCustomerSchema.shape.name,
    email: createCustomerSchema.shape.email,
    phone: createCustomerSchema.shape.phone,
    address: postalAddressInputSchema.nullable().optional().openapi({ description: "The first address, which becomes the default." }),
    skipAddressValidation: z.boolean().optional().openapi({
        description: "Save the address as given, without the country's address rules.",
    }),
});

/** A postal address as the customers service takes it (place ids beside the canonical fields). */
function serviceAddress(address: PostalAddressInput, skipValidation: boolean | undefined) {
    const { placeIds, ...lines } = address;
    return {
        ...lines,
        city: placeIds?.city ?? null,
        zone: placeIds?.zone ?? null,
        area: placeIds?.area ?? null,
        ...(skipValidation === undefined ? {} : { skipValidation }),
    };
}

const createCustomerRoute = createRoute({
    operationId: "dashboard.customers.create",
    method: "post",
    path: "/",
    tags: ["Admin - Customers"],
    summary: "Create a customer",
    request: {
        body: { content: { "application/json": { schema: createCustomerBody } } }
    },
    responses: {
        201: { description: "The new customer", content: { "application/json": { schema: customerEnvelope } } },
        ...errorResponses,
    }
});

app.openapi(createCustomerRoute, async (c) => {
    const db = c.get("db");
    const { address, skipAddressValidation, ...contact } = c.req.valid("json");
    const { id } = await createCustomer(db, {
        ...contact,
        address: address ? serviceAddress(address, skipAddressValidation) : address,
    }, staffId(c));
    return created(c, { customer: await readCustomerResource(db, id) });
});

// ── Bulk Delete Customers ──

const bulkDeleteRoute = createRoute({
    operationId: "dashboard.customers.bulk_delete",
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Customers"],
    summary: "Bulk delete customers",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        customerIds: z.array(z.string().min(1).max(128)).min(1).max(90).optional(),
                        matching: customerMatchingSchema.optional(),
                        permanent: z.boolean().default(false)
                    })
                }
            }
        }
    },
    responses: {
        200: {
            description: "Customers moved to trash or deleted; with `matching`, where the next slice starts",
            content: { "application/json": { schema: successEnvelope(z.object({ matching: matchingResultSchema.optional() })) } },
        },
        ...errorResponses,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const { customerIds: listed, matching, permanent } = c.req.valid("json");
    requireOneSelection(listed, matching);
    // A permanent delete reads only customers without orders: the others stay in Trash.
    assertContactSearchAllowed(c, "matching.filter.search", matching?.filter.search);
    const slice = matching ? await readCustomerSlice(db, matching, { trashed: permanent, deletableOnly: permanent }) : null;
    const customerIds = slice ? slice.ids : listed!;
    if (customerIds.length > 0) await bulkDeleteCustomers(db, customerIds, permanent);
    return ok(c, slice ? { matching: { processed: customerIds.length, skipped: 0, next: slice.next } satisfies MatchingResult } : {});
});

// ── Bulk Restore Customers ──

app.openapi(createRoute({
    operationId: "dashboard.customers.bulk_restore",
    method: "post",
    path: "/bulk-restore",
    tags: ["Admin - Customers"],
    summary: "Restore several trashed customers",
    description: "Restores the listed customers, or one slice of the trashed customers a filter matches (`matching`). A guest record merged into an account stays merged.",
    request: {
        body: { required: true, content: { "application/json": { schema: z.object({
            customerIds: z.array(z.string().min(1).max(128)).min(1).max(90).optional(),
            matching: customerMatchingSchema.optional(),
        }) } } },
    },
    responses: {
        200: {
            description: "Customers restored",
            content: { "application/json": { schema: successEnvelope(z.object({
                restored: z.array(z.string()),
                blocked: z.array(z.string()),
                matching: matchingResultSchema.optional(),
            })) } },
        },
        ...errorResponses,
    },
}), async (c) => {
    const db = c.get("db");
    const { customerIds: listed, matching } = c.req.valid("json");
    requireOneSelection(listed, matching);
    assertContactSearchAllowed(c, "matching.filter.search", matching?.filter.search);
    const slice = matching ? await readCustomerSlice(db, matching, { trashed: true, limit: planLimits().lists.bulkPerRowSlice }) : null;
    const result = await bulkRestoreCustomers(db, slice ? slice.ids : listed!, staffId(c));
    return ok(c, {
        ...result,
        ...(slice ? { matching: { processed: result.restored.length, skipped: result.blocked.length, next: slice.next } satisfies MatchingResult } : {}),
    });
});

// ── Get Customer By ID ──

const getByIdRoute = createRoute({
    operationId: "dashboard.customers.get",
    method: "get",
    path: "/{id}",
    tags: ["Admin - Customers"],
    summary: "Get a customer by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Customer details", content: { "application/json": { schema: successEnvelope(customerDetailSchema.extend({ relatedObjects: z.array(relatedObjectRecordSchema) })) } } },
        ...errorResponses,
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const customer = await getCustomerDetail(db, id, relatedObjectsProjection(c, "customer", id));
    if (!customer) throw new NotFoundError("Customer not found");
    return ok(c, withRelatedObjects(customer));
});

// ── Update Customer ──

const updateCustomerRoute = createRoute({
    operationId: "dashboard.customers.update",
    method: "put",
    path: "/{id}",
    tags: ["Admin - Customers"],
    summary: "Update a customer",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateCustomerSchema } } }
    },
    responses: {
        200: { description: "The customer as updated", content: { "application/json": { schema: customerEnvelope } } },
        ...errorResponses,
    }
});

app.openapi(updateCustomerRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await updateCustomer(db, id, c.req.valid("json"), staffId(c));
    return ok(c, { customer: await readCustomerResource(db, id) });
});

// ── Delete Customer ──

const deleteCustomerRoute = createRoute({
    operationId: "dashboard.customers.delete",
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Customers"],
    summary: "Soft-delete a customer",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        404: errorResponses[404],
    }
});

app.openapi(deleteCustomerRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteCustomer(db, id, staffId(c));
    return noContent(c);
});

// ── Permanent Delete Customer ──

const permanentDeleteRoute = createRoute({
    operationId: "dashboard.customers.delete_permanently",
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Customers"],
    summary: "Permanently delete a customer",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await permanentlyDeleteCustomer(db, id);
    return noContent(c);
});

// ── Restore Customer ──

const restoreCustomerRoute = createRoute({
    operationId: "dashboard.customers.restore",
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Customers"],
    summary: "Restore a soft-deleted customer",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(restoreCustomerRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await restoreCustomer(db, id, staffId(c));
    return noContent(c);
});

// ── Erase a customer's personal data (final audit I10) ──

const eraseResultSchema = z.object({
    customerId: z.string(),
    erased: z.boolean().openapi({ description: "False when the customer was already erased: nothing changed." }),
    mergedRecords: z.number().int().openapi({ description: "Guest records merged into this customer, erased with it." }),
    orders: z.number().int().openapi({ description: "Orders whose contact and addresses were scrubbed. Their money, lines and region stay." }),
    files: z.number().int().openapi({ description: "The buyer's conversation images deleted from storage." }),
}).openapi("CustomerErasureResult");

const eraseCustomerRoute = createRoute({
    operationId: "dashboard.customers.erase",
    method: "post",
    path: "/{id}/erase",
    tags: ["Admin - Customers"],
    summary: "Erase a customer's personal data",
    description: "The right to erasure for a customer who ordered. Scrubs the customer's contact and every guest record merged into it; deletes their addresses, sign-in identities, sessions, saved payment methods (detached at their provider first), marketing consents, push subscriptions and app roles; scrubs the contact, recipient, street lines, phones and notes on their orders (money, lines and region stay for the books); gives their reviews the fallback name; and erases their words and images in conversations. The record is retired and cannot be restored. Emits `customer.erased` so apps erase their copies. Refused while an order is still in progress. Only a Super Admin may erase (an agent only for a Super Admin owner); it cannot be undone.",
    request: {
        params: z.object({ id: z.string().min(1).max(128) }),
    },
    responses: {
        200: { description: "Erased", content: { "application/json": { schema: successEnvelope(eraseResultSchema) } } },
        ...errorResponses,
    },
});

app.openapi(eraseCustomerRoute, async (c) => {
    c.header("Cache-Control", "private, no-store");
    const actor = c.get("user") as { id?: string; isSuperAdmin?: boolean } | undefined;
    // An agent acts for its owner: it may erase only when that owner is a Super Admin. Apps never may.
    if (!actor?.id || actor.isSuperAdmin !== true || c.get("pluginPrincipal")) {
        throw new ForbiddenError("Only the store owner can erase a customer's data.");
    }
    const { id } = c.req.valid("param");
    const db = c.get("db");
    // Detach saved methods at their provider while the references still exist; erasure deletes them either way.
    const methods = await listCustomerPaymentMethods(db, id, { kind: "staff" });
    for (const method of methods) {
        await removeCustomerPaymentMethod(db, {
            methodId: method.id,
            actor: { kind: "customer", customerId: id },
            providers: () => requestPaymentProviders(c),
            encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
        }).catch(() => undefined);
    }
    const result = await eraseCustomer(db, { customerId: id, actorId: actor.id, files: c.env.BUCKET ?? null });
    return ok(c, result);
});

// ── The address book (MARKETS-DESIGN D7, Shopify's customer addresses) ──

const addressListPayload = z.object({ addresses: z.array(customerAddressSchema) });
const addressParams = z.object({ id: z.string(), addressId: z.string() });

const listAddressesRoute = createRoute({
    operationId: "dashboard.customers.addresses_list",
    method: "get",
    path: "/{id}/addresses",
    tags: ["Admin - Customers"],
    summary: "List a customer's addresses",
    description: "The address book, the default first. Each address has the canonical fields its country's rules allow (GET /api/v1/address-rules/{countryCode}) and, in Bangladesh, the City/Thana/Area location ids and names.",
    request: { params: z.object({ id: z.string() }) },
    responses: {
        200: { description: "Addresses", content: { "application/json": { schema: successEnvelope(addressListPayload) } } },
        ...errorResponses,
    },
});

app.openapi(listAddressesRoute, async (c) => {
    const { id } = c.req.valid("param");
    return ok(c, { addresses: await listCustomerAddresses(c.get("db"), id) });
});

const createAddressRoute = createRoute({
    operationId: "dashboard.customers.addresses_create",
    method: "post",
    path: "/{id}/addresses",
    tags: ["Admin - Customers"],
    summary: "Add an address to a customer's address book",
    description: "The country's rules decide the required fields; a Bangladesh address sends the City/Thana/Area ids (`city`, `zone`, optional `area`). The first address is the default; `isDefault` makes a later one the default. `skipValidation` keeps an address that breaks its rules, marked validationSkipped.",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: customerAddressInputSchema } } },
    },
    responses: {
        201: { description: "Address added", content: { "application/json": { schema: successEnvelope(customerAddressSchema) } } },
        ...errorResponses,
    },
});

app.openapi(createAddressRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { skipValidation, ...address } = c.req.valid("json");
    return created(c, await createCustomerAddress(c.get("db"), id, address, { skipValidation }));
});

const updateAddressRoute = createRoute({
    operationId: "dashboard.customers.addresses_update",
    method: "put",
    path: "/{id}/addresses/{addressId}",
    tags: ["Admin - Customers"],
    summary: "Replace an address in a customer's address book",
    request: {
        params: addressParams,
        body: { content: { "application/json": { schema: customerAddressInputSchema } } },
    },
    responses: {
        200: { description: "Address updated", content: { "application/json": { schema: successEnvelope(customerAddressSchema) } } },
        ...errorResponses,
    },
});

app.openapi(updateAddressRoute, async (c) => {
    const { id, addressId } = c.req.valid("param");
    const { skipValidation, ...address } = c.req.valid("json");
    return ok(c, await updateCustomerAddress(c.get("db"), id, addressId, address, { skipValidation }));
});

const setDefaultAddressRoute = createRoute({
    operationId: "dashboard.customers.addresses_set_default",
    method: "post",
    path: "/{id}/addresses/{addressId}/default",
    tags: ["Admin - Customers"],
    summary: "Make an address the customer's default",
    request: { params: addressParams },
    responses: {
        200: { description: "Default address", content: { "application/json": { schema: successEnvelope(customerAddressSchema) } } },
        ...errorResponses,
    },
});

app.openapi(setDefaultAddressRoute, async (c) => {
    const { id, addressId } = c.req.valid("param");
    return ok(c, await setDefaultCustomerAddress(c.get("db"), id, addressId));
});

const setDefaultBillingAddressRoute = createRoute({
    operationId: "dashboard.customers.addresses_set_default_billing",
    method: "post",
    path: "/{id}/addresses/{addressId}/default-billing",
    tags: ["Admin - Customers"],
    summary: "Make an address the customer's default billing address",
    description: "Without one, the default address bills too.",
    request: { params: addressParams },
    responses: {
        200: { description: "Default billing address", content: { "application/json": { schema: successEnvelope(customerAddressSchema) } } },
        ...errorResponses,
    },
});

app.openapi(setDefaultBillingAddressRoute, async (c) => {
    const { id, addressId } = c.req.valid("param");
    return ok(c, await setDefaultBillingCustomerAddress(c.get("db"), id, addressId));
});

const deleteAddressRoute = createRoute({
    operationId: "dashboard.customers.addresses_delete",
    method: "delete",
    path: "/{id}/addresses/{addressId}",
    tags: ["Admin - Customers"],
    summary: "Remove an address from a customer's address book",
    description: "When the default goes, the most recently updated other address becomes the default.",
    request: { params: addressParams },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    },
});

app.openapi(deleteAddressRoute, async (c) => {
    const { id, addressId } = c.req.valid("param");
    await deleteCustomerAddress(c.get("db"), id, addressId);
    return noContent(c);
});

// ── Saved payment methods (security audit N3) ──
// The cards or wallets a provider kept for this customer, with what each was
// kept for and the app that may charge it. Staff remove one when the buyer
// asks; the buyer can also do it in their account.

const paymentMethodListPayload = z.object({ paymentMethods: z.array(staffSavedPaymentMethodSchema) });

const listPaymentMethodsRoute = createRoute({
    operationId: "dashboard.customers.payment_methods_list",
    method: "get",
    path: "/{id}/payment-methods",
    tags: ["Admin - Customers"],
    summary: "List a customer's saved payment methods",
    description: "Active cards or wallets kept by a payment provider for charges without the buyer, oldest first: brand, last four digits, expiry, what each was kept for and the app that may charge it. Never the provider's reference.",
    request: { params: z.object({ id: z.string() }) },
    responses: {
        200: { description: "Saved payment methods", content: { "application/json": { schema: successEnvelope(paymentMethodListPayload) } } },
        ...errorResponses,
    },
});

app.openapi(listPaymentMethodsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const methods = await listCustomerPaymentMethods(c.get("db"), id, { kind: "staff" });
    return ok(c, { paymentMethods: methods.map(staffSavedPaymentMethod) });
});

const deletePaymentMethodRoute = createRoute({
    operationId: "dashboard.customers.payment_methods_delete",
    method: "delete",
    path: "/{id}/payment-methods/{methodId}",
    tags: ["Admin - Customers"],
    summary: "Remove a customer's saved payment method",
    description: "Detaches the method at its provider, then removes it: nothing can charge it again. Answers the customer's remaining methods.",
    request: { params: z.object({ id: z.string(), methodId: z.string().min(1).max(128) }) },
    responses: {
        200: { description: "Saved payment methods", content: { "application/json": { schema: successEnvelope(paymentMethodListPayload) } } },
        ...errorResponses,
    },
});

app.openapi(deletePaymentMethodRoute, async (c) => {
    const { id, methodId } = c.req.valid("param");
    const db = c.get("db");
    // Scoped to this customer's methods: a method id from another customer reads as not found.
    await removeCustomerPaymentMethod(db, {
        methodId,
        actor: { kind: "customer", customerId: id },
        providers: () => requestPaymentProviders(c),
        encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    });
    const methods = await listCustomerPaymentMethods(db, id, { kind: "staff" });
    return ok(c, { paymentMethods: methods.map(staffSavedPaymentMethod) });
});

// ── Get Customer History ──

const getHistoryRoute = createRoute({
    operationId: "dashboard.customers.history",
    method: "get",
    path: "/{id}/history",
    tags: ["Admin - Customers"],
    summary: "Get customer details with history and orders",
    request: {
        params: z.object({ id: z.string() }),
        query: z.object({
            historyPage: z.coerce.number().int().min(1).default(1),
            historyLimit: z.coerce.number().int().min(1).max(50).default(20),
            ordersPage: z.coerce.number().int().min(1).default(1),
            ordersLimit: z.coerce.number().int().min(1).max(25).default(5),
        }),
    },
    responses: {
        200: { description: "Customer history data", content: { "application/json": { schema: successEnvelope(customerHistoryPayloadSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getHistoryRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { historyPage, historyLimit, ordersPage, ordersLimit } = c.req.valid("query");
    const metrics = buildCustomerOrderMetricsProjection();
    const historyOffset = (historyPage - 1) * historyLimit;
    const ordersOffset = (ordersPage - 1) * ordersLimit;

    const mergedInto = alias(customers, "merged_into");
    const relatedCustomer = alias(customers, "related_customer");
    const movedOrder = alias(orders, "moved_order");
    const samePhone = alias(customers, "same_phone");
    const [customerResults, history, customerOrders, historyCountRows, orderCountRows, samePhoneRows] = await db.batch([
        db
            .select({
                id: customers.id,
                name: customers.name,
                email: customers.email,
                phone: customers.phone,
                accountClaimedAt: sql<number | null>`CAST(${customers.accountClaimedAt} AS INTEGER)`,
                origin: customers.origin,
                latestOrderName: latestOrderNameSql().as("latest_order_name"),
                mergedIntoId: sql<string | null>`${mergedInto.id}`.as("merged_into_id"),
                mergedIntoName: sql<string | null>`${mergedInto.name}`.as("merged_into_name"),
                totalOrders: metrics.totalOrders,
                totalSpentMinor: metrics.totalSpentMinor,
                spendDecimalPlaces: metrics.spendDecimalPlaces,
                lastOrderAt: metrics.lastOrderAt,
                createdAt: sql<number>`CAST(${customers.createdAt} AS INTEGER)`,
                updatedAt: sql<number>`CAST(${customers.updatedAt} AS INTEGER)`,
                deletedAt: sql<number | null>`CAST(${customers.deletedAt} AS INTEGER)`,
                erasedAt: sql<number | null>`CAST(${customers.erasedAt} AS INTEGER)`,
            })
            .from(customers)
            .leftJoin(orders, and(
                eq(orders.customerId, customers.id),
                isNull(orders.deletedAt),
            ))
            .leftJoin(mergedInto, eq(mergedInto.id, customers.mergedIntoCustomerId))
            .where(eq(customers.id, id))
            .groupBy(customers.id, mergedInto.id),
        db
            .select({
                id: customerHistory.id,
                name: customerHistory.name,
                email: customerHistory.email,
                phone: customerHistory.phone,
                changeType: customerHistory.changeType,
                orderId: customerHistory.orderId,
                orderNumber: sql<number | null>`${movedOrder.orderNumber}`.as("moved_order_number"),
                relatedCustomerId: customerHistory.relatedCustomerId,
                relatedCustomerName: sql<string | null>`${relatedCustomer.name}`.as("related_customer_name"),
                relatedCustomerPhone: sql<string | null>`${relatedCustomer.phone}`.as("related_customer_phone"),
                relatedCustomerClaimedAt: sql<number | null>`${relatedCustomer.accountClaimedAt}`.as("related_customer_claimed_at"),
                relatedCustomerOrigin: sql<string | null>`${relatedCustomer.origin}`.as("related_customer_origin"),
                verifiedContact: customerHistory.verifiedContact,
                actor: customerHistory.actor,
                actorName: sql<string | null>`${user.name}`.as("actor_name"),
                createdAt: sql<number>`CAST(${customerHistory.createdAt} AS INTEGER)`,
            })
            .from(customerHistory)
            .leftJoin(movedOrder, eq(movedOrder.id, customerHistory.orderId))
            .leftJoin(relatedCustomer, eq(relatedCustomer.id, customerHistory.relatedCustomerId))
            .leftJoin(user, eq(user.id, customerHistory.actorId))
            .where(eq(customerHistory.customerId, id))
            .orderBy(sql`${customerHistory.createdAt} DESC`)
            .limit(historyLimit)
            .offset(historyOffset),
        db
            .select({
                id: orders.id,
                orderNumber: orders.orderNumber,
                customerName: orders.customerName,
                totalAmountMinor: orders.totalAmountMinor,
                currencyDecimalPlaces: orders.currencyDecimalPlaces,
                status: orders.status,
                createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            })
            .from(orders)
            .where(and(
                eq(orders.customerId, id),
                isNull(orders.deletedAt),
            ))
            .orderBy(sql`${orders.createdAt} DESC`)
            .limit(ordersLimit)
            .offset(ordersOffset),
        db
            .select({ total: sql<number>`COUNT(*)` })
            .from(customerHistory)
            .where(eq(customerHistory.customerId, id)),
        db
            .select({ total: sql<number>`COUNT(*)` })
            .from(orders)
            .where(and(
                eq(orders.customerId, id),
                isNull(orders.deletedAt),
            )),
        db
            .select({
                id: samePhone.id,
                name: samePhone.name,
                phone: samePhone.phone,
                accountClaimedAt: samePhone.accountClaimedAt,
                origin: samePhone.origin,
            })
            .from(samePhone)
            .innerJoin(customers, eq(customers.id, id))
            .where(and(
                // Customers without a phone never share one.
                isNotNull(contactPhoneSql(customers.phone)),
                eq(samePhone.phone, customers.phone),
                sql`${samePhone.id} != ${id}`,
                isNull(samePhone.deletedAt),
            ))
            .limit(5),
    ]);

    const customer = customerResults[0];
    if (!customer) throw new NotFoundError("Customer not found");

    const { totalSpentMinor, spendDecimalPlaces, origin, mergedIntoId, mergedIntoName, ...customerFacts } = customer;
    const enrichedCustomer = {
        ...customerFacts,
        kind: customerKind({ accountClaimedAt: customer.accountClaimedAt, origin }),
        deletedAt: customer.deletedAt ? new Date(customer.deletedAt * 1000) : null,
        erasedAt: customer.erasedAt ? new Date(customer.erasedAt * 1000) : null,
        mergedInto: mergedIntoId ? { id: mergedIntoId, name: mergedIntoName ?? "" } : null,
        samePhone: samePhoneRows.flatMap((row) => row.phone ? [{ id: row.id, name: row.name, phone: row.phone, kind: customerKind(row) }] : []),
        totalSpent: paidSpendAmount({ totalSpentMinor, spendDecimalPlaces }),
        accountClaimedAt: customer.accountClaimedAt ? new Date(customer.accountClaimedAt * 1000) : null,
        lastOrderAt: customer.lastOrderAt ? new Date(customer.lastOrderAt * 1000) : null,
        createdAt: new Date(customer.createdAt * 1000),
        updatedAt: new Date(customer.updatedAt * 1000),
    };

    const enrichedHistory = history.map(({
        orderId, orderNumber, relatedCustomerId, relatedCustomerName, relatedCustomerPhone,
        relatedCustomerClaimedAt, relatedCustomerOrigin, actor, actorName, ...record
    }) => ({
        ...record,
        author: actor ? { kind: actor, name: actorName ?? null } : null,
        order: orderId ? { id: orderId, orderNumber: orderNumber ?? null } : null,
        relatedCustomer: relatedCustomerId
            ? {
                id: relatedCustomerId,
                name: relatedCustomerName ?? "",
                phone: phoneOrNull(relatedCustomerPhone),
                kind: customerKind({ accountClaimedAt: relatedCustomerClaimedAt, origin: relatedCustomerOrigin }),
            }
            : null,
        createdAt: new Date(record.createdAt * 1000),
    }));

    const enrichedOrders = customerOrders.map(({ totalAmountMinor, currencyDecimalPlaces, ...order }) => ({
        ...order,
        totalAmount: fromMinor(totalAmountMinor, currencyDecimalPlaces),
        createdAt: new Date(order.createdAt * 1000),
    }));

    const historyTotal = Number(historyCountRows[0]?.total ?? 0);
    const ordersTotal = Number(orderCountRows[0]?.total ?? 0);
    const historyTotalPages = Math.ceil(historyTotal / historyLimit);
    const ordersTotalPages = Math.ceil(ordersTotal / ordersLimit);

    return ok(c, {
        customer: enrichedCustomer,
        history: enrichedHistory,
        orders: enrichedOrders,
        pagination: {
            history: {
                page: historyPage,
                limit: historyLimit,
                total: historyTotal,
                totalPages: historyTotalPages,
                hasNextPage: historyPage < historyTotalPages,
            },
            orders: {
                page: ordersPage,
                limit: ordersLimit,
                total: ordersTotal,
                totalPages: ordersTotalPages,
                hasNextPage: ordersPage < ordersTotalPages,
            },
        },
    });
});

export { app as adminCustomerRoutes };
