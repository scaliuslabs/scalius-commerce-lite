import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    MAX_DELIVERY_AMOUNT,
    MAX_ZONE_LOCATIONS,
    MAX_ZONE_RATES,
    MAX_ZONE_REGIONS,
    applyDeliveryZoneTemplate,
    createDeliveryZone,
    deleteDeliveryZone,
    listDeliveryZones,
    updateDeliveryZone,
    updatePickupRates,
} from "@scalius/core/modules/delivery";
import { getCurrencyConfig } from "@scalius/core/modules/settings";
import { readStoreCurrency } from "@scalius/core/modules/markets";

import { ok, created, noContent } from "../../../utils/api-response";
import { successEnvelope, noContentResponse, errorResponses, conflictResponse } from "../../../schemas/responses";

// Shipping zones (Shopify's model, MARKETS-DESIGN step 3b): the countries,
// admin areas, postal-code prefixes and Bangladesh delivery areas each zone
// serves, its delivery rates, and local pickup. Rates are checkout data and
// feed Product/Offer JSON-LD and catalog feeds on cached pages; database
// triggers advance dependencies.
const app = new OpenAPIHono<{ Bindings: Env }>();

const TAGS = ["Admin - Shipping Zones"];

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

const regionInputSchema = z.object({
    countryCode: z.string().trim().length(2, "Use a two-letter ISO country code."),
    adminArea: z.string().trim().max(120).optional().nullable().openapi({
        description: "One admin area (state, province, division) of the country: its address rules' code or name. Omit for the whole country.",
    }),
    postalPrefix: z.string().trim().max(20).optional().nullable().openapi({
        description: "Postal codes that start with these letters and digits (spaces and dashes are ignored, at most 10). Omit for the whole country.",
    }),
});

const zoneInputSchema = z.object({
    name: z.string().trim().min(1, "Enter a zone name.").max(100),
    regions: z.array(regionInputSchema).max(MAX_ZONE_REGIONS).default([]).openapi({
        description: "Countries, admin areas and postal-code prefixes. A region belongs to one zone. Bangladesh is served whole here or through `locationIds`.",
    }),
    locationIds: z.array(z.string().trim().min(1).max(128))
        .max(MAX_ZONE_LOCATIONS)
        .default([])
        .openapi({ description: "Bangladesh delivery areas (cities, thanas, areas). A place belongs to one zone." }),
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
        regions: z.array(z.object({
            countryCode: z.string(),
            adminArea: z.string().nullable(),
            postalPrefix: z.string().nullable(),
        })),
        locations: z.array(z.object({
            id: z.string(),
            name: z.string(),
            type: z.enum(["city", "zone", "area"]),
            parentName: z.string().nullable(),
        })),
        rates: z.array(rateSchema),
    })),
    pickup: z.object({ revision: z.number().int(), rates: z.array(rateSchema) }),
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
    summary: "List shipping zones (their regions, delivery areas and rates) and local pickup",
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
    summary: "Create a shipping zone with its regions, delivery areas and rates",
    request: { body: { required: true, content: { "application/json": { schema: zoneInputSchema } } } },
    responses: {
        201: { description: "Zone created", content: { "application/json": { schema: successEnvelope(revisionSchema) } } },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(createZoneRoute, async (c) => {
    const db = c.get("db");
    const result = await createDeliveryZone(db, c.req.valid("json"), await readStoreCurrency(db));

    return created(c, result);
});

const pickupRoute = createRoute({
    method: "put",
    path: "/pickup",
    operationId: "dashboard.shipping_zones.pickup_update",
    tags: TAGS,
    summary: "Replace the local pickup rates (offered to every buyer)",
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

app.openapi(pickupRoute, async (c) => {
    const db = c.get("db");
    const { rates, expectedRevision } = c.req.valid("json");
    const result = await updatePickupRates(db, rates, expectedRevision, await readStoreCurrency(db));

    return ok(c, result);
});

const templateRoute = createRoute({
    method: "put",
    path: "/template",
    operationId: "dashboard.shipping_zones.apply_template",
    tags: TAGS,
    summary: "Start from Dhaka-centric zones (inside/outside, or inside/near/outside Dhaka), only without zones",
    request: {
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        template: z.enum(["dhaka_two_zone", "dhaka_three_zone"]),
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
    const { template } = c.req.valid("json");
    await applyDeliveryZoneTemplate(db, template, await readStoreCurrency(db));

    return noContent(c);
});

const updateZoneRoute = createRoute({
    method: "put",
    path: "/{id}",
    operationId: "dashboard.shipping_zones.update",
    tags: TAGS,
    summary: "Replace a shipping zone's name, regions, delivery areas and rates",
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
    const result = await updateDeliveryZone(db, id, zone, expectedRevision, await readStoreCurrency(db));

    return ok(c, result);
});

const deleteZoneRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.shipping_zones.delete",
    tags: TAGS,
    summary: "Delete a shipping zone; its addresses fall to the next matching zone, or get no delivery rate",
    request: { params: zoneParams },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    },
});

app.openapi(deleteZoneRoute, async (c) => {
    const db = c.get("db");
    await deleteDeliveryZone(db, c.req.valid("param").id);

    return noContent(c);
});

export { app as shippingMethodsSettingsRoutes };
