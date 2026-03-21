import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getBusinessSettings,
    saveBusinessSettings,
} from "@scalius/core/modules/settings/business-settings.service";
import { ok } from "../../../utils/api-response";
import { successEnvelope, messageResponse, errorResponses } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────

const businessInfoSchema = z.object({
    companyName: z.string(),
    legalName: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string(),
    city: z.string(),
    stateRegion: z.string(),
    postalCode: z.string(),
    country: z.string(),
    phone: z.string(),
    email: z.string(),
    taxId: z.string(),
    invoicePrefix: z.string(),
    invoiceFooterText: z.string(),
    invoiceLogoUrl: z.string(),
});

const saveBusinessSchema = z.object({
    companyName: z.string().optional(),
    legalName: z.string().optional(),
    addressLine1: z.string().optional(),
    addressLine2: z.string().optional(),
    city: z.string().optional(),
    stateRegion: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    taxId: z.string().optional(),
    invoicePrefix: z.string().optional(),
    invoiceFooterText: z.string().optional(),
    invoiceLogoUrl: z.string().optional(),
});

// ─────────────────────────────────────────
// GET /business
// ─────────────────────────────────────────

const getBusinessRoute = createRoute({
    method: "get",
    path: "/business",
    tags: ["Admin - Settings"],
    summary: "Get business settings",
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
    return ok(c, result);
});

// ─────────────────────────────────────────
// POST /business
// ─────────────────────────────────────────

const saveBusinessRoute = createRoute({
    method: "post",
    path: "/business",
    tags: ["Admin - Settings"],
    summary: "Save business settings",
    request: {
        body: { content: { "application/json": { schema: saveBusinessSchema } } },
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
    return ok(c, { message: "Business settings saved successfully" });
});

export { app as businessSettingsRoutes };
