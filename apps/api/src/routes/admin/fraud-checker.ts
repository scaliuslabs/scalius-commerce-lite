// src/server/routes/admin/fraud-checker.ts
// Admin OpenAPI routes for fraud checker providers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getFraudProviders, getFraudProvider, saveFraudProvider, deleteFraudProvider, testFraudProvider, fraudLookupWithActiveProvider } from "@scalius/core/modules/fraud-checker/fraud-checker.service";

import { ok, created } from "../../utils/api-response";
import { ValidationError } from "../../utils/api-error";
import { successEnvelope, errorResponses } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED_VALUE = "••••••••••••";
const providerTypeSchema = z.enum(["default", "fraudbd", "fraudguard", "ecourier"]);

function maskProviderSecrets<T extends { apiKey?: string; apiSecret?: string }>(provider: T): T {
    return {
        ...provider,
        apiKey: provider.apiKey ? MASKED_VALUE : "",
        ...(provider.apiSecret !== undefined ? { apiSecret: provider.apiSecret ? MASKED_VALUE : "" } : {}),
    };
}

// ── List Providers ──

const fraudProviderSchema = z.object({
    id: z.string(),
    name: z.string(),
    apiUrl: z.string(),
    apiKey: z.string(),
    apiSecret: z.string().optional(),
    userId: z.string().optional(),
    isActive: z.boolean(),
    providerType: providerTypeSchema.optional(),
}).passthrough();

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Fraud Checker"],
    summary: "List all fraud checker providers",
    responses: {
        200: { description: "Provider list", content: { "application/json": { schema: successEnvelope(z.array(fraudProviderSchema)) } } },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const providers = await getFraudProviders(db);

    const maskedProviders = providers.map(maskProviderSecrets);

    return ok(c, maskedProviders);
});

// ── Create Provider ──

const createProviderSchema = z.object({
    name: z.string().min(1),
    apiUrl: z.string().min(1),
    apiKey: z.string().min(1),
    apiSecret: z.string().optional(),
    userId: z.string().optional(),
    isActive: z.boolean().optional().default(true),
    providerType: providerTypeSchema.optional().default("default"),
});

const createProviderRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Fraud Checker"],
    summary: "Create a fraud checker provider",
    request: {
        body: { content: { "application/json": { schema: createProviderSchema } } }
    },
    responses: {
        201: { description: "Provider created", content: { "application/json": { schema: successEnvelope(fraudProviderSchema) } } },
        ...errorResponses,
    }
});

app.openapi(createProviderRoute, async (c) => {
    const db = c.get("db");
    const provider = c.req.valid("json");

    const savedProvider = await saveFraudProvider(db, provider);

    const maskedResponse = maskProviderSecrets(savedProvider);

    return created(c, maskedResponse);
});

// ── Update Provider ──

const updateProviderSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    apiUrl: z.string().min(1),
    apiKey: z.string().min(1),
    apiSecret: z.string().optional(),
    userId: z.string().optional(),
    isActive: z.boolean().default(true),
    providerType: providerTypeSchema.optional().default("default"),
});

const updateProviderRoute = createRoute({
    method: "put",
    path: "/",
    tags: ["Admin - Fraud Checker"],
    summary: "Update a fraud checker provider",
    request: {
        body: { content: { "application/json": { schema: updateProviderSchema } } }
    },
    responses: {
        200: { description: "Provider updated", content: { "application/json": { schema: successEnvelope(fraudProviderSchema) } } },
        ...errorResponses,
    }
});

app.openapi(updateProviderRoute, async (c) => {
    const db = c.get("db");
    const validated = c.req.valid("json");
    let apiKey = validated.apiKey;
    let apiSecret = validated.apiSecret;

    if (apiKey === MASKED_VALUE) {
        const existingProvider = await getFraudProvider(db, validated.id);
        if (existingProvider?.apiKey) {
            apiKey = existingProvider.apiKey;
        }
    }

    if (apiSecret === MASKED_VALUE) {
        const existingProvider = await getFraudProvider(db, validated.id);
        if (existingProvider?.apiSecret) {
            apiSecret = existingProvider.apiSecret;
        }
    }

    const savedProvider = await saveFraudProvider(db, { ...validated, apiKey, apiSecret });

    const maskedResponse = maskProviderSecrets(savedProvider);

    return ok(c, maskedResponse);
});

// ── Delete Provider ──

const deleteProviderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Fraud Checker"],
    summary: "Delete a fraud checker provider",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Provider deleted", content: { "application/json": { schema: successEnvelope(z.object({})) } } },
        ...errorResponses,
    }
});

app.openapi(deleteProviderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await deleteFraudProvider(db, id);
    return ok(c, {});
});

// ── Test Provider ──

const testProviderRoute = createRoute({
    method: "post",
    path: "/{id}/test",
    tags: ["Admin - Fraud Checker"],
    summary: "Test a fraud checker provider connection",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Test result", content: { "application/json": { schema: successEnvelope(z.object({ success: z.boolean(), message: z.string().optional() }).passthrough()) } } },
        ...errorResponses,
    }
});

app.openapi(testProviderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await testFraudProvider(db, id);
    return ok(c, result);
});

// ── Lookup (phone) ──

const lookupSchema = z.object({
    phone: z.string().min(1),
});

const lookupRoute = createRoute({
    method: "post",
    path: "/lookup",
    tags: ["Admin - Fraud Checker"],
    summary: "Lookup fraud data for a phone number",
    request: {
        body: { content: { "application/json": { schema: lookupSchema } } }
    },
    responses: {
        200: { description: "Lookup result", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } } },
        ...errorResponses,
    }
});

app.openapi(lookupRoute, async (c) => {
    const db = c.get("db");
    const { phone } = c.req.valid("json");
    const result = await fraudLookupWithActiveProvider(db, phone);
    return ok(c, result.data ?? {});
});

export { app as adminFraudCheckerRoutes };
