import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    MAX_DELIVERY_AMOUNT,
    MAX_ZONE_LOCATIONS,
    MAX_ZONE_RATES,
    applyDeliveryZoneTemplate,
    createDeliveryZone,
    deleteDeliveryZone,
    listDeliveryZones,
    updateDeliveryZone,
    updateEverywhereElseRates,
} from "@scalius/core/modules/delivery/zones";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";

import { ok, created, noContent } from "../../../utils/api-response";
import { successEnvelope, noContentResponse, errorResponses, conflictResponse } from "../../../schemas/responses";
import { bumpCacheGeneration } from "../../../utils/cache-generation";

// Delivery zones and their rates. Rates are checkout data and feed
// Product/Offer JSON-LD on cached pages, so every write bumps the store cache
// generation after it commits.
const app = new OpenAPIHono<{ Bindings: Env }>();

const TAGS = ["Admin - Delivery Zones"];

const amount = (message: string) => z.number().min(0, "Enter 0 or more.").max(MAX_DELIVERY_AMOUNT, message);

const rateInputSchema = z.object({
    id: z.string().max(128).optional().nullable(),
    name: z.string().trim().min(1, "Enter a name buyers will see.").max(100),
    fee: amount("Enter a charge up to 1,00,000."),
    freeOver: amount("Enter an amount up to 1,00,000.").optional().nullable(),
    description: z.string().max(255).optional().nullable(),
    kind: z.enum(["delivery", "pickup"]).optional().default("delivery"),
    pickupAddress: z.string().max(500, "Use 500 characters or fewer.").optional().nullable(),
    pickupHours: z.string().max(120, "Use 120 characters or fewer.").optional().nullable(),
    isActive: z.boolean(),
});
const ratesSchema = z.array(rateInputSchema).max(MAX_ZONE_RATES);

const zoneInputSchema = z.object({
    name: z.string().trim().min(1, "Enter a zone name.").max(100),
    locationIds: z.array(z.string().trim().min(1).max(128))
        .min(1, "Choose at least one city, thana or area.")
        .max(MAX_ZONE_LOCATIONS),
    rates: ratesSchema,
});

const rateSchema = z.object({
    id: z.string(),
    kind: z.enum(["delivery", "pickup"]),
    name: z.string(),
    fee: z.number(),
    freeOver: z.number().nullable(),
    description: z.string().nullable(),
    pickupAddress: z.string().nullable(),
    pickupHours: z.string().nullable(),
    isActive: z.boolean(),
});

const zonesSchema = z.object({
    zones: z.array(z.object({
        id: z.string(),
        name: z.string(),
        revision: z.number().int(),
        locations: z.array(z.object({
            id: z.string(),
            name: z.string(),
            type: z.enum(["city", "zone", "area"]),
            parentName: z.string().nullable(),
        })),
        rates: z.array(rateSchema),
    })),
    everywhereElse: z.object({ revision: z.number().int(), rates: z.array(rateSchema) }),
});

const revisionSchema = z.object({ id: z.string().optional(), revision: z.number().int() });
const zoneParams = z.object({ id: z.string().min(1).max(128) });

async function storeDecimalPlaces(db: Parameters<typeof getCurrencyConfig>[0]): Promise<number> {
    return (await getCurrencyConfig(db)).decimalPlaces;
}

const listRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.shipping_methods.list",
    tags: TAGS,
    summary: "List delivery zones, their areas and rates, plus the Everywhere else rates",
    responses: {
        200: { description: "Delivery zones", content: { "application/json": { schema: successEnvelope(zonesSchema) } } },
        ...errorResponses,
    },
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    return ok(c, await listDeliveryZones(db, await storeDecimalPlaces(db)));
});

const createZoneRoute = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.shipping_zones.create",
    tags: TAGS,
    summary: "Create a delivery zone with its areas and rates",
    request: { body: { required: true, content: { "application/json": { schema: zoneInputSchema } } } },
    responses: {
        201: { description: "Zone created", content: { "application/json": { schema: successEnvelope(revisionSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(createZoneRoute, async (c) => {
    const db = c.get("db");
    const result = await createDeliveryZone(db, c.req.valid("json"), await storeDecimalPlaces(db));
    await bumpCacheGeneration(c);
    return created(c, result);
});

const everywhereElseRoute = createRoute({
    method: "put",
    path: "/everywhere-else",
    operationId: "dashboard.shipping_zones.everywhere_else_update",
    tags: TAGS,
    summary: "Replace the rates for addresses outside every delivery zone",
    request: {
        body: {
            required: true,
            content: { "application/json": { schema: z.object({ rates: ratesSchema, expectedRevision: z.number().int().min(0) }) } },
        },
    },
    responses: {
        200: { description: "Rates saved", content: { "application/json": { schema: successEnvelope(revisionSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(everywhereElseRoute, async (c) => {
    const db = c.get("db");
    const { rates, expectedRevision } = c.req.valid("json");
    const result = await updateEverywhereElseRates(db, rates, expectedRevision, await storeDecimalPlaces(db));
    await bumpCacheGeneration(c);
    return ok(c, result);
});

const templateRoute = createRoute({
    method: "put",
    path: "/template",
    operationId: "dashboard.shipping_zones.apply_template",
    tags: TAGS,
    summary: "Start from Dhaka-centric zones (inside/outside, or inside/near/outside Dhaka)",
    request: {
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        template: z.enum(["dhaka_two_zone", "dhaka_three_zone"]),
                        expectedRevision: z.number().int().min(0).openapi({ description: "The Everywhere else revision the dashboard loaded." }),
                    }),
                },
            },
        },
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(templateRoute, async (c) => {
    const db = c.get("db");
    const { template, expectedRevision } = c.req.valid("json");
    await applyDeliveryZoneTemplate(db, template, expectedRevision, await storeDecimalPlaces(db));
    await bumpCacheGeneration(c);
    return noContent(c);
});

const updateZoneRoute = createRoute({
    method: "put",
    path: "/{id}",
    operationId: "dashboard.shipping_zones.update",
    tags: TAGS,
    summary: "Replace a delivery zone's name, areas and rates",
    request: {
        params: zoneParams,
        body: {
            required: true,
            content: { "application/json": { schema: zoneInputSchema.extend({ expectedRevision: z.number().int().min(1) }) } },
        },
    },
    responses: {
        200: { description: "Zone saved", content: { "application/json": { schema: successEnvelope(revisionSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(updateZoneRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedRevision, ...zone } = c.req.valid("json");
    const result = await updateDeliveryZone(db, id, zone, expectedRevision, await storeDecimalPlaces(db));
    await bumpCacheGeneration(c);
    return ok(c, result);
});

const deleteZoneRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.shipping_zones.delete",
    tags: TAGS,
    summary: "Delete a delivery zone; its areas get the Everywhere else rates",
    request: { params: zoneParams },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    },
});

app.openapi(deleteZoneRoute, async (c) => {
    const db = c.get("db");
    await deleteDeliveryZone(db, c.req.valid("param").id);
    await bumpCacheGeneration(c);
    return noContent(c);
});

export { app as shippingMethodsSettingsRoutes };
