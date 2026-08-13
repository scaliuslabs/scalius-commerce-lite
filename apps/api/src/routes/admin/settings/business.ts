import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getBusinessSettings,
    saveBusinessSettings,
    type BusinessInfo,
} from "@scalius/core/modules/settings/business-settings.service";
import { ok } from "../../../utils/api-response";
import { successEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";
import { invalidateApiAndScheduleStorefrontGroups } from "../../../utils/cache-invalidation";
import { normalizePublicMediaUrl } from "@scalius/shared/media-url";

const app = new OpenAPIHono<{ Bindings: Env }>();
const LAYOUT_CACHE_GROUPS = ["layout"] as const;
const BUSINESS_FIELD_LIMITS = {
    companyName: 200,
    legalName: 200,
    addressLine1: 300,
    addressLine2: 300,
    city: 120,
    stateRegion: 120,
    postalCode: 32,
    country: 120,
    phone: 64,
    email: 320,
    taxId: 128,
    invoicePrefix: 32,
    invoiceFooterText: 4_000,
    invoiceLogoUrl: 2_048,
} as const satisfies Record<keyof BusinessInfo, number>;

function projectBusinessSettings(settings: BusinessInfo): BusinessInfo {
    return Object.fromEntries(
        Object.entries(BUSINESS_FIELD_LIMITS).map(([key, maximumLength]) => [
            key,
            settings[key as keyof BusinessInfo].slice(0, maximumLength),
        ]),
    ) as unknown as BusinessInfo;
}

// ─────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────

const businessInfoSchema = z.object({
    companyName: z.string().max(BUSINESS_FIELD_LIMITS.companyName),
    legalName: z.string().max(BUSINESS_FIELD_LIMITS.legalName),
    addressLine1: z.string().max(BUSINESS_FIELD_LIMITS.addressLine1),
    addressLine2: z.string().max(BUSINESS_FIELD_LIMITS.addressLine2),
    city: z.string().max(BUSINESS_FIELD_LIMITS.city),
    stateRegion: z.string().max(BUSINESS_FIELD_LIMITS.stateRegion),
    postalCode: z.string().max(BUSINESS_FIELD_LIMITS.postalCode),
    country: z.string().max(BUSINESS_FIELD_LIMITS.country),
    phone: z.string().max(BUSINESS_FIELD_LIMITS.phone),
    email: z.string().max(BUSINESS_FIELD_LIMITS.email),
    taxId: z.string().max(BUSINESS_FIELD_LIMITS.taxId),
    invoicePrefix: z.string().max(BUSINESS_FIELD_LIMITS.invoicePrefix),
    invoiceFooterText: z.string().max(BUSINESS_FIELD_LIMITS.invoiceFooterText),
    invoiceLogoUrl: z.string().max(BUSINESS_FIELD_LIMITS.invoiceLogoUrl),
});

const saveBusinessSchema = businessInfoSchema.partial().extend({
    invoiceLogoUrl: z.string().trim().max(BUSINESS_FIELD_LIMITS.invoiceLogoUrl).refine(
        (value) => value === "" || normalizePublicMediaUrl(value) !== null,
        "Use an HTTPS image URL or a root-relative application asset.",
    ).optional(),
});

// ─────────────────────────────────────────
// GET /business
// ─────────────────────────────────────────

const getBusinessRoute = createRoute({
    method: "get",
    path: "/business",
    tags: ["Admin - Settings"],
    summary: "Get business settings",
    operationId: "dashboard.settings.business_get",
    responses: {
        200: {
            description: "Business settings",
            content: { "application/json": { schema: successEnvelope(businessInfoSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(getBusinessRoute, async (c) => {
    const db = c.get("db");
    const result = await getBusinessSettings(db);
    return ok(c, projectBusinessSettings(result));
});

// ─────────────────────────────────────────
// POST /business
// ─────────────────────────────────────────

const saveBusinessRoute = createRoute({
    method: "post",
    path: "/business",
    tags: ["Admin - Settings"],
    summary: "Save business settings",
    operationId: "dashboard.settings.business_update",
    request: {
        body: {
            required: true,
            content: { "application/json": { schema: saveBusinessSchema } },
        },
    },
    responses: {
        200: {
            description: "Business settings saved",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    },
});

app.openapi(saveBusinessRoute, async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    await saveBusinessSettings(db, body);
    await invalidateApiAndScheduleStorefrontGroups(LAYOUT_CACHE_GROUPS, c);
    return ok(c, { message: "Business settings saved successfully" });
});

export { app as businessSettingsRoutes };
