// src/server/routes/admin/fraud-checker.ts
// Admin OpenAPI routes for fraud checker providers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getFraudProviders, getFraudProvider, saveFraudProvider, deleteFraudProvider, testFraudProvider, fraudLookupWithActiveProvider } from "@scalius/core/modules/fraud-checker/fraud-checker.service";
import { FRAUD_CHECK_PROVIDER_TYPES } from "@scalius/core/modules/fraud-checker/provider";
import { getEncryptionKey, requireEncryptionKey } from "../../utils/encryption-key";

import { ok, created } from "../../utils/api-response";
import { successEnvelope, errorResponses } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED_VALUE = "••••••••••••";
const providerTypeSchema = z.enum(FRAUD_CHECK_PROVIDER_TYPES);

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
    const providers = await getFraudProviders(db, getEncryptionKey(c.env as Record<string, unknown>));

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
    const encryptionKey = requireEncryptionKey(c.env as Record<string, unknown>);

    const savedProvider = await saveFraudProvider(db, provider, encryptionKey);

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
    const env = c.env as Record<string, unknown>;
    const readKey = getEncryptionKey(env);
    const encryptionKey = requireEncryptionKey(env);
    let apiKey = validated.apiKey;
    let apiSecret = validated.apiSecret;

    if (apiKey === MASKED_VALUE) {
        const existingProvider = await getFraudProvider(db, validated.id, readKey);
        if (existingProvider?.apiKey) {
            apiKey = existingProvider.apiKey;
        }
    }

    if (apiSecret === MASKED_VALUE) {
        const existingProvider = await getFraudProvider(db, validated.id, readKey);
        if (existingProvider?.apiSecret) {
            apiSecret = existingProvider.apiSecret;
        }
    }

    const savedProvider = await saveFraudProvider(db, { ...validated, apiKey, apiSecret }, encryptionKey);

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
    const result = await testFraudProvider(db, id, getEncryptionKey(c.env as Record<string, unknown>));
    return ok(c, result);
});

// ── Lookup (phone) ──

const lookupSchema = z.object({
    phone: z.string().min(1),
});

const lookupResponseSchema = z.object({
    mobile_number: z.string().optional(),
    total_parcels: z.number().optional(),
    total_delivered: z.number().optional(),
    total_cancel: z.number().optional(),
    provider_status: z.string().optional(),
    message: z.string().optional(),
    customer_tag: z.string().optional(),
    success_rate: z.number().optional(),
    cancel_rate: z.number().optional(),
    riskLevel: z.enum(["low", "medium", "high", "unknown"]).optional(),
    apis: z.record(z.string(), z.object({
        total_parcels: z.number(),
        total_delivered_parcels: z.number(),
        total_cancelled_parcels: z.number(),
    })).optional(),
}).passthrough();

const lookupRoute = createRoute({
    method: "post",
    path: "/lookup",
    tags: ["Admin - Fraud Checker"],
    summary: "Lookup fraud data for a phone number",
    request: {
        body: { content: { "application/json": { schema: lookupSchema } } }
    },
    responses: {
        200: { description: "Lookup result", content: { "application/json": { schema: successEnvelope(lookupResponseSchema) } } },
        ...errorResponses,
    }
});

app.openapi(lookupRoute, async (c) => {
    const db = c.get("db");
    const { phone } = c.req.valid("json");
    const result = await fraudLookupWithActiveProvider(db, phone, getEncryptionKey(c.env as Record<string, unknown>));
    return ok(c, {
        ...(result.data ?? {}),
        ...(result.riskLevel ? { riskLevel: result.riskLevel } : {}),
    });
});

export { app as adminFraudCheckerRoutes };
