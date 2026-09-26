import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getBusinessSettingsDocument,
    saveBusinessSettings,
    type BusinessInfo,
} from "@scalius/core/modules/settings";
import { ok } from "../../../utils/api-response";
import { successEnvelope, conflictResponse, errorResponses } from "../../../schemas/responses";

import { normalizePublicMediaUrl } from "@scalius/shared/media-url";

const app = new OpenAPIHono<{ Bindings: Env }>();
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

const businessDocumentSchema = businessInfoSchema.extend({
    revision: z.number().int().nonnegative(),
});

const saveBusinessSchema = businessInfoSchema.partial().extend({
    expectedRevision: z.number().int().nonnegative(),
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
            content: { "application/json": { schema: successEnvelope(businessDocumentSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(getBusinessRoute, async (c) => {
    const { revision, ...settings } = await getBusinessSettingsDocument(c.get("db"));
    return ok(c, { ...projectBusinessSettings(settings), revision });
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
            content: { "application/json": { schema: successEnvelope(businessDocumentSchema) } },
        },
        ...errorResponses,
        409: conflictResponse,
    },
});

app.openapi(saveBusinessRoute, async (c) => {
    const { expectedRevision, ...fields } = c.req.valid("json");
    const saved = await saveBusinessSettings(c.get("db"), fields, { expectedRevision });

    return ok(c, { ...projectBusinessSettings(saved.value), revision: saved.revision });
});

export { app as businessSettingsRoutes };
