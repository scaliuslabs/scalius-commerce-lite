// Admin routes for Customers & marketing, mounted at /admin/customers before
// the customer routes (static paths first): tags, saved segments, the CSV
// export and one customer's marketing consent. Money in segment definitions
// crosses this edge in decimal major units (the store currency) and is stored
// in integer minor units.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { isoTimestampSchema, nullableIsoTimestampSchema } from "../../schemas/timestamps";
import { assertContactSearchAllowed } from "./contact-access";
import { protectedField as pii } from "../../schemas/protected";
import {
    CUSTOMER_EXPORT_MAX_ROWS,
    addTagsToCustomers,
    buildCustomerCsvExport,
    countSegmentMembers,
    createCustomerSegment,
    deleteCustomerSegment,
    getCustomerSegment,
    listCustomerSegments,
    listCustomerTags,
    listSegmentMemberIds,
    listStoreCustomerTags,
    parseSegmentDefinition,
    removeTagsFromCustomers,
    setCustomerTags,
    updateCustomerSegment,
    listCustomers,
    listMatchingCustomerIds,
    type CustomerSegmentRecord,
} from "@scalius/core/modules/customers";
import {
    getCustomerMarketingConsents,
    listCustomerConsentEvents,
    setCustomerMarketingConsent,
} from "@scalius/core/modules/customer-marketing";
import { currencyDocument } from "@scalius/core/modules/settings";
import { customers, user } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
    CUSTOMER_TAGS_PER_CUSTOMER_MAX,
    CUSTOMER_TAGS_PER_REQUEST_MAX,
    MARKETING_CHANNELS,
    MARKETING_CONSENT_ACTORS,
    MARKETING_CONSENT_SOURCES,
    MARKETING_CONSENT_STATES,
    MARKETING_CONSENT_STATUSES,
    customerSegmentDefinitionInputSchema,
    mapSegmentMoney,
    normalizeCustomerTag,
    type CustomerSegmentDefinition,
    type CustomerSegmentDefinitionInput,
} from "@scalius/shared/customer-marketing";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { eq, inArray } from "drizzle-orm";
import { ok, created, noContent } from "../../utils/api-response";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { conflictResponse, errorResponses, namedSharedSchema, noContentResponse, successEnvelope } from "../../schemas/responses";
import { customerSummarySchema } from "../../schemas/entities";
import { customerEnvelope, readCustomerResource } from "./customer-resource";
import { matchingResultSchema, matchingSchema, requireOneSelection, type MatchingResult } from "../../schemas/bulk-matching";
import { appListQuerySchema, planAppList } from "../../plugins/list-columns";
import { BULK_MATCHING_SLICE, readMatchingCursor } from "@scalius/core/utils/bulk-matching";
import { notificationSender } from "../../background/notification-sender";

const listFilterQuery = {
    tag: z.string().max(200).optional().openapi({ description: "Customers with this tag" }),
    segmentId: z.string().max(64).optional().openapi({ description: "Customers in this saved segment" }),
    subscribed: z.enum([...MARKETING_CHANNELS, "any"]).optional().openapi({ description: "Customers subscribed on this channel now (any: on at least one)" }),
};

/**
 * The customers list's filter for "all matching" bulk actions
 * (schemas/bulk-matching.ts). The tab (Trash or not) is the action's own.
 */
export const customerMatchingSchema = matchingSchema(z.object({
    search: z.string().trim().max(120).optional(),
    ...listFilterQuery,
    appFilter: appListQuerySchema.appFilter,
}).strict());
export type CustomerMatching = z.infer<typeof customerMatchingSchema>;

/** One slice of the customers a bulk action's filter matches. */
export async function readCustomerSlice(
    db: Database,
    matching: CustomerMatching,
    options: { trashed: boolean; deletableOnly?: boolean; limit?: number },
) {
    const { filter } = matching;
    const appList = await planAppList(db, "customer", customers.id, { appFilter: filter.appFilter });
    return listMatchingCustomerIds(db, {
        search: filter.search || undefined,
        showTrashed: options.trashed,
        filters: await customerListFiltersFromQuery(db, options.trashed ? { tag: filter.tag, segmentId: filter.segmentId } : filter),
        appCondition: appList.condition,
    }, readMatchingCursor(matching.cursor), options.limit ?? BULK_MATCHING_SLICE, { deletableOnly: options.deletableOnly });
}

const app = new OpenAPIHono<{ Bindings: Env }>();

type Ctx = { get: (key: string) => unknown };
const staffId = (c: Ctx) => (c.get("user") as { id?: string } | undefined)?.id ?? null;
const pluginId = (c: Ctx) => (c.get("pluginPrincipal") as { pluginId?: string } | undefined)?.pluginId ?? null;

async function storeDecimals(db: Database): Promise<number> {
    return getDecimalPlaces((await currencyDocument.read(db)).currencyCode);
}

/** A request definition (major units) as stored (minor units), with references checked. */
async function definitionFromInput(db: Database, input: CustomerSegmentDefinitionInput): Promise<CustomerSegmentDefinition> {
    const decimals = await storeDecimals(db);
    return parseSegmentDefinition(db, mapSegmentMoney(input, (amount) => toMinor(amount, decimals)));
}

function segmentView(record: CustomerSegmentRecord, decimals: number) {
    return { ...record, definition: mapSegmentMoney(record.definition, (amount) => fromMinor(amount, decimals)) };
}

/** A segment's rules (one contract component: lists, reads, writes and previews share it). */
const segmentDefinitionSchema = namedSharedSchema(customerSegmentDefinitionInputSchema, "CustomerSegmentDefinition");

const segmentSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    definition: segmentDefinitionSchema,
    revision: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Discounts (not archived) limited to this segment. */
    promotionCount: z.number().int(),
}).openapi("CustomerSegment");

const segmentIdParam = z.object({ segmentId: z.string().min(1).max(64) });
const customerIdParam = z.object({ id: z.string().min(1).max(128) });
const countSchema = z.object({ count: z.number().int(), capped: z.boolean() });
const tagList = z.array(z.string().max(200)).max(CUSTOMER_TAGS_PER_CUSTOMER_MAX);

// ── Tags ────────────────────────────────────────────────────────────────

const listTagsRoute = createRoute({
    operationId: "dashboard.customers.tags_list",
    method: "get",
    path: "/tags",
    tags: ["Admin - Customers"],
    summary: "List customer tags",
    description: "The store's customer tags with how many live customers carry each, most used first.",
    request: {
        query: z.object({
            q: z.string().max(40).optional().openapi({ description: "Part of a tag" }),
            limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
    },
    responses: {
        200: {
            description: "Tags",
            content: { "application/json": { schema: successEnvelope(z.object({ tags: z.array(z.object({ tag: z.string(), customers: z.number().int() })) })) } },
        },
        ...errorResponses,
    },
});

app.openapi(listTagsRoute, async (c) => {
    const query = c.req.valid("query");
    return ok(c, { tags: await listStoreCustomerTags(c.get("db"), { query: query.q, limit: query.limit }) });
});

const bulkTagsRoute = createRoute({
    operationId: "dashboard.customers.tags_bulk_update",
    method: "post",
    path: "/tags/bulk",
    tags: ["Admin - Customers"],
    summary: "Add or remove tags on many customers",
    request: {
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        customerIds: z.array(z.string().min(1).max(128)).min(1).max(500).optional(),
                        matching: customerMatchingSchema.optional(),
                        add: z.array(z.string().max(200)).max(CUSTOMER_TAGS_PER_REQUEST_MAX).optional(),
                        remove: z.array(z.string().max(200)).max(CUSTOMER_TAGS_PER_REQUEST_MAX).optional(),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Tags changed",
            content: { "application/json": { schema: successEnvelope(z.object({
                customers: z.number().int(),
                added: z.array(z.string()),
                removed: z.array(z.string()),
                matching: matchingResultSchema.optional(),
            })) } },
        },
        ...errorResponses,
    },
});

app.openapi(bulkTagsRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    if (!body.add?.length && !body.remove?.length) throw new ValidationError("Give tags to add or remove.");
    requireOneSelection(body.customerIds, body.matching);
    assertContactSearchAllowed(c, "matching.filter.search", body.matching?.filter.search);
    const slice = body.matching ? await readCustomerSlice(db, body.matching, { trashed: false }) : null;
    const customerIds = slice ? slice.ids : body.customerIds!;
    const add = body.add ?? [];
    const remove = body.remove ?? [];
    const added = add.length && customerIds.length ? (await addTagsToCustomers(db, { customerIds, tags: add })).tags : [];
    const removed = remove.length && customerIds.length ? (await removeTagsFromCustomers(db, { customerIds, tags: remove })).tags : [];
    return ok(c, {
        customers: new Set(customerIds).size,
        added,
        removed,
        ...(slice ? { matching: { processed: customerIds.length, skipped: 0, next: slice.next } satisfies MatchingResult } : {}),
    });
});

const setTagsRoute = createRoute({
    operationId: "dashboard.customers.tags_set",
    method: "put",
    path: "/{id}/tags",
    tags: ["Admin - Customers"],
    summary: "Replace one customer's tags",
    request: {
        params: customerIdParam,
        body: { required: true, content: { "application/json": { schema: z.object({ tags: tagList }).strict() } } },
    },
    responses: {
        200: { description: "The customer with its new tags", content: { "application/json": { schema: customerEnvelope } } },
        ...errorResponses,
    },
});

app.openapi(setTagsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await setCustomerTags(db, id, c.req.valid("json").tags);
    return ok(c, { customer: await readCustomerResource(db, id) });
});

// ── Export ──────────────────────────────────────────────────────────────

/** The list filters of a request, with the saved segment resolved. */
export async function customerListFiltersFromQuery(
    db: Database,
    query: { tag?: string; segmentId?: string; subscribed?: (typeof MARKETING_CHANNELS)[number] | "any" },
) {
    const tag = query.tag ? normalizeCustomerTag(query.tag) : null;
    if (query.tag && !tag) throw new ValidationError("A tag is 1 to 40 characters.");
    const segment = query.segmentId ? (await getCustomerSegment(db, query.segmentId)).definition : undefined;
    return {
        ...(tag ? { tag } : {}),
        ...(segment ? { segment } : {}),
        ...(query.subscribed ? { subscribed: query.subscribed } : {}),
    };
}

const exportRoute = createRoute({
    operationId: "dashboard.customers.export",
    method: "get",
    path: "/export",
    tags: ["Admin - Customers"],
    summary: "Export customers as CSV",
    description: `Live customers of a tag, saved segment or subscriber channel (or the given ids), with order facts, tags and consent per channel. At most ${CUSTOMER_EXPORT_MAX_ROWS} rows; X-Export-Limited says when the file stopped early.`,
    request: {
        query: z.object({
            ...listFilterQuery,
            ids: z.string().max(100 * 130).optional().openapi({ description: "Comma-separated customer ids (at most 100)" }),
            maxRows: z.coerce.number().int().min(1).max(CUSTOMER_EXPORT_MAX_ROWS).optional(),
        }),
    },
    responses: {
        200: {
            description: "CSV file",
            content: { "text/csv": { schema: z.string() } },
        },
        ...errorResponses,
    },
});

app.openapi(exportRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const ids = query.ids ? query.ids.split(",").map((id) => id.trim()).filter(Boolean) : undefined;
    if (ids && ids.length > 100) throw new ValidationError("Export at most 100 chosen customers; use a filter for more.");
    const exported = await buildCustomerCsvExport(db, {
        filters: await customerListFiltersFromQuery(db, query),
        ids,
        maxRows: query.maxRows,
    });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(exported.body, {
        status: 200,
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="customers-${day}.csv"`,
            "Cache-Control": "private, no-store",
            "X-Export-Row-Count": String(exported.rowCount),
            "X-Export-Limited": exported.limited ? "true" : "false",
        },
    }) as never;
});

// ── Segments ────────────────────────────────────────────────────────────

const listSegmentsRoute = createRoute({
    operationId: "dashboard.customers.segments_list",
    method: "get",
    path: "/segments",
    tags: ["Admin - Customers"],
    summary: "List saved customer segments",
    responses: {
        200: { description: "Segments", content: { "application/json": { schema: successEnvelope(z.object({ segments: z.array(segmentSchema) })) } } },
        ...errorResponses,
    },
});

app.openapi(listSegmentsRoute, async (c) => {
    const db = c.get("db");
    const decimals = await storeDecimals(db);
    return ok(c, { segments: (await listCustomerSegments(db)).map((segment) => segmentView(segment, decimals)) });
});

const segmentBody = z.object({
    name: z.string().max(200),
    description: z.string().max(600).nullable().optional(),
    definition: segmentDefinitionSchema,
}).strict();

const createSegmentRoute = createRoute({
    operationId: "dashboard.customers.segments_create",
    method: "post",
    path: "/segments",
    tags: ["Admin - Customers"],
    summary: "Save a customer segment",
    request: { body: { required: true, content: { "application/json": { schema: segmentBody } } } },
    responses: {
        201: { description: "Segment saved", content: { "application/json": { schema: successEnvelope(segmentSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(createSegmentRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    const record = await createCustomerSegment(db, { ...body, definition: await definitionFromInput(db, body.definition) }, staffId(c));
    return created(c, segmentView(record, await storeDecimals(db)));
});

const previewSegmentRoute = createRoute({
    operationId: "dashboard.customers.segments_preview",
    method: "post",
    path: "/segments/preview",
    tags: ["Admin - Customers"],
    summary: "Count and sample a segment before saving it",
    description: "Live member count (capped) and the first customers of an unsaved definition. Changes nothing.",
    request: { body: { required: true, content: { "application/json": { schema: z.object({ definition: segmentDefinitionSchema }).strict() } } } },
    responses: {
        200: {
            description: "Preview",
            content: { "application/json": { schema: successEnvelope(countSchema.extend({ customers: z.array(customerSummarySchema) })) } },
        },
        ...errorResponses,
    },
});

app.openapi(previewSegmentRoute, async (c) => {
    const db = c.get("db");
    const definition = await definitionFromInput(db, c.req.valid("json").definition);
    const [count, page] = [await countSegmentMembers(db, definition), await listCustomers(db, { limit: 10, filters: { segment: definition } })];
    return ok(c, { ...count, customers: page.customers });
});

const getSegmentRoute = createRoute({
    operationId: "dashboard.customers.segments_get",
    method: "get",
    path: "/segments/{segmentId}",
    tags: ["Admin - Customers"],
    summary: "Get a customer segment",
    request: { params: segmentIdParam },
    responses: {
        200: { description: "Segment", content: { "application/json": { schema: successEnvelope(segmentSchema) } } },
        ...errorResponses,
    },
});

app.openapi(getSegmentRoute, async (c) => {
    const db = c.get("db");
    return ok(c, segmentView(await getCustomerSegment(db, c.req.valid("param").segmentId), await storeDecimals(db)));
});

const updateSegmentRoute = createRoute({
    operationId: "dashboard.customers.segments_update",
    method: "put",
    path: "/segments/{segmentId}",
    tags: ["Admin - Customers"],
    summary: "Change a customer segment",
    request: {
        params: segmentIdParam,
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: segmentBody.partial().extend({ expectedRevision: z.number().int().min(1) }).strict(),
                },
            },
        },
    },
    responses: {
        200: { description: "Segment saved", content: { "application/json": { schema: successEnvelope(segmentSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(updateSegmentRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    const record = await updateCustomerSegment(db, c.req.valid("param").segmentId, {
        expectedRevision: body.expectedRevision,
        name: body.name,
        description: body.description,
        definition: body.definition ? await definitionFromInput(db, body.definition) : undefined,
    });
    return ok(c, segmentView(record, await storeDecimals(db)));
});

const deleteSegmentRoute = createRoute({
    operationId: "dashboard.customers.segments_delete",
    method: "delete",
    path: "/segments/{segmentId}",
    tags: ["Admin - Customers"],
    summary: "Delete a customer segment",
    description: "Refused while a discount (not archived) is limited to it.",
    request: { params: segmentIdParam },
    responses: {
        204: noContentResponse,
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(deleteSegmentRoute, async (c) => {
    await deleteCustomerSegment(c.get("db"), c.req.valid("param").segmentId);
    return noContent(c);
});

const countSegmentRoute = createRoute({
    operationId: "dashboard.customers.segments_count",
    method: "get",
    path: "/segments/{segmentId}/count",
    tags: ["Admin - Customers"],
    summary: "Count a segment's members now",
    request: { params: segmentIdParam },
    responses: {
        200: { description: "Live member count (capped)", content: { "application/json": { schema: successEnvelope(countSchema) } } },
        ...errorResponses,
    },
});

app.openapi(countSegmentRoute, async (c) => {
    const db = c.get("db");
    const segment = await getCustomerSegment(db, c.req.valid("param").segmentId);
    return ok(c, await countSegmentMembers(db, segment.definition));
});

const membersRoute = createRoute({
    operationId: "dashboard.customers.segments_members",
    method: "get",
    path: "/segments/{segmentId}/members",
    tags: ["Admin - Customers"],
    summary: "Walk a segment's members",
    description: "Member ids in id order, one page after `after` (keyset; plugins and agents walk a whole segment this way).",
    request: {
        params: segmentIdParam,
        query: z.object({
            after: z.string().max(128).optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
    },
    responses: {
        200: {
            description: "A page of member ids",
            content: { "application/json": { schema: successEnvelope(z.object({ customerIds: z.array(z.string()), next: z.string().nullable() })) } },
        },
        ...errorResponses,
    },
});

app.openapi(membersRoute, async (c) => {
    const db = c.get("db");
    const segment = await getCustomerSegment(db, c.req.valid("param").segmentId);
    const query = c.req.valid("query");
    const customerIds = await listSegmentMemberIds(db, segment.definition, { afterId: query.after ?? null, limit: query.limit });
    return ok(c, { customerIds, next: customerIds.length === query.limit ? customerIds.at(-1)! : null });
});

// ── One customer's marketing consent ─────────────────────────────────────

// A consent's address is an email or a phone (by channel): an app sees it only with both scopes.
const consentViewSchema = z.object({
    channel: z.enum(MARKETING_CHANNELS),
    status: z.enum(MARKETING_CONSENT_STATUSES),
    state: z.enum(MARKETING_CONSENT_STATES).nullable(),
    contact: pii(["email", "phone"], z.string().nullable()),
    consentContact: pii(["email", "phone"], z.string().nullable()),
    source: z.enum(MARKETING_CONSENT_SOURCES).nullable(),
    consentTextVersion: z.string().nullable(),
    subscribedAt: nullableIsoTimestampSchema,
    unsubscribedAt: nullableIsoTimestampSchema,
    requestedAt: nullableIsoTimestampSchema,
    updatedAt: nullableIsoTimestampSchema,
});

const consentEventSchema = z.object({
    id: z.string(),
    channel: z.enum(MARKETING_CHANNELS),
    previousState: z.enum(MARKETING_CONSENT_STATES).nullable(),
    state: z.enum(MARKETING_CONSENT_STATES),
    source: z.enum(MARKETING_CONSENT_SOURCES),
    actor: z.enum(MARKETING_CONSENT_ACTORS),
    /** A staff member's name or a plugin id. */
    actorName: z.string().nullable(),
    note: z.string().nullable(),
    contact: pii(["email", "phone"], z.string()),
    consentTextVersion: z.string().nullable(),
    consentText: z.string().nullable(),
    createdAt: isoTimestampSchema,
});

const marketingPayloadSchema = z.object({
    consents: z.array(consentViewSchema),
    events: z.array(consentEventSchema),
    tags: z.array(z.string()),
});

async function marketingPayload(db: Database, customerId: string) {
    const exists = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).get();
    if (!exists) throw new NotFoundError("Customer not found");
    const [consents, events, tags] = await Promise.all([
        getCustomerMarketingConsents(db, customerId),
        listCustomerConsentEvents(db, customerId),
        listCustomerTags(db, customerId),
    ]);
    const staffIds = [...new Set(events.filter((event) => event.actor === "staff" && event.actorId).map((event) => event.actorId!))];
    const names = staffIds.length
        ? new Map((await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, staffIds.slice(0, 90)))).map((row) => [row.id, row.name]))
        : new Map<string, string>();
    return {
        consents,
        events: events.map(({ actorId, ...event }) => ({
            ...event,
            actorName: event.actor === "staff" ? (actorId ? names.get(actorId) ?? null : null) : event.actor === "plugin" ? actorId : null,
        })),
        tags,
    };
}

const getMarketingRoute = createRoute({
    operationId: "dashboard.customers.marketing_get",
    method: "get",
    path: "/{id}/marketing",
    tags: ["Admin - Customers"],
    summary: "Get a customer's marketing consent and tags",
    description: "Consent per channel (what applies to the current address), the consent audit log and the tags.",
    request: { params: customerIdParam },
    responses: {
        200: { description: "Consent, audit log and tags", content: { "application/json": { schema: successEnvelope(marketingPayloadSchema) } } },
        ...errorResponses,
    },
});

app.openapi(getMarketingRoute, async (c) => {
    return ok(c, await marketingPayload(c.get("db"), c.req.valid("param").id));
});

const updateMarketingRoute = createRoute({
    operationId: "dashboard.customers.marketing_update",
    method: "put",
    path: "/{id}/marketing",
    tags: ["Admin - Customers"],
    summary: "Record a customer's marketing consent",
    description: "Subscribe (consent the customer gave outside the store; a note saying how is required) or unsubscribe one channel. Kept on the audit log with the author.",
    request: {
        params: customerIdParam,
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        channel: z.enum(MARKETING_CHANNELS),
                        state: z.enum(["subscribed", "unsubscribed"]),
                        note: z.string().max(500).nullable().optional(),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: { description: "Consent recorded", content: { "application/json": { schema: successEnvelope(marketingPayloadSchema) } } },
        ...errorResponses,
    },
});

app.openapi(updateMarketingRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const plugin = pluginId(c);
    await setCustomerMarketingConsent(db, id, c.req.valid("json"), plugin
        ? { actor: "plugin", actorId: plugin }
        : { actor: "staff", actorId: staffId(c) }, { env: c.env as never, send: notificationSender(c) });
    return ok(c, await marketingPayload(db, id));
});

// Re-exported for the customer list route (one place that turns query filters into list filters).
export { listFilterQuery as customerListFilterQuery };
export { app as adminCustomerMarketingRoutes };
