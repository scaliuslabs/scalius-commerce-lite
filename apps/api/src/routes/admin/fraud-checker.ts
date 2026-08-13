// src/server/routes/admin/fraud-checker.ts
// Admin OpenAPI routes for fraud checker providers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getFraudProviders, getFraudProvider, saveFraudProvider, deleteFraudProvider, testFraudProvider, fraudLookupWithActiveProvider } from "@scalius/core/modules/fraud-checker/fraud-checker.service";
import { FRAUD_CHECK_PROVIDER_TYPES } from "@scalius/core/modules/fraud-checker/provider";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../utils/encryption-key";
import { ValidationError } from "../../utils/api-error";

import { ok, created } from "../../utils/api-response";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED_VALUE = "••••••••••••";
const FRAUD_PROVIDER_PAGE_LIMIT = 20;
const providerTypeSchema = z.enum(FRAUD_CHECK_PROVIDER_TYPES);

function safeProviderUrlForClient(value: string): string {
    try {
        const parsed = new URL(value);
        if (
            parsed.protocol !== "https:"
            || parsed.username
            || parsed.password
            || parsed.search
            || parsed.hash
        ) return "";
        return parsed.toString();
    } catch {
        return "";
    }
}

function maskProviderSecrets(provider: {
    id: string;
    name: string;
    apiUrl: string;
    apiKey: string;
    apiSecret?: string;
    userId?: string;
    isActive: boolean;
    providerType?: (typeof FRAUD_CHECK_PROVIDER_TYPES)[number];
}) {
    return {
        id: provider.id.slice(0, 100),
        name: provider.name.slice(0, 100),
        apiUrl: safeProviderUrlForClient(provider.apiUrl),
        apiKey: provider.apiKey ? MASKED_VALUE : "",
        ...(provider.apiSecret !== undefined ? { apiSecret: provider.apiSecret ? MASKED_VALUE : "" } : {}),
        ...(provider.userId !== undefined ? { userId: provider.userId ? MASKED_VALUE : "" } : {}),
        isActive: provider.isActive,
        providerType: provider.providerType,
    };
}

const secureProviderUrlSchema = z.string().url().max(2048).superRefine((value, ctx) => {
    const parsed = new URL(value);
    if (
        parsed.protocol !== "https:"
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash
    ) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provider URL must be HTTPS and cannot include credentials, a query, or a fragment",
        });
    }
});

function safeProviderTestResult(result: { success?: unknown }) {
    const success = result.success === true;
    return {
        success,
        message: success ? "Connection successful" : "Connection failed",
    };
}

function finiteNonNegative(value: unknown): number | undefined {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : undefined;
}

function boundedText(value: unknown, max = 100): string | undefined {
    return typeof value === "string" && value.trim()
        ? value.trim().slice(0, max)
        : undefined;
}

function projectFraudLookupResult(
    data: Record<string, unknown> | undefined,
    riskLevel: "low" | "medium" | "high" | "unknown" | undefined,
) {
    const rawApis = data?.apis && typeof data.apis === "object" && !Array.isArray(data.apis)
        ? data.apis as Record<string, unknown>
        : {};
    const apis = Object.fromEntries(
        Object.entries(rawApis).slice(0, 20).flatMap(([provider, value]) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [];
            const row = value as Record<string, unknown>;
            return [[provider.slice(0, 80), {
                total_parcels: finiteNonNegative(row.total_parcels) ?? 0,
                total_delivered_parcels: finiteNonNegative(row.total_delivered_parcels) ?? 0,
                total_cancelled_parcels: finiteNonNegative(row.total_cancelled_parcels) ?? 0,
            }]];
        }),
    );

    return {
        total_parcels: finiteNonNegative(data?.total_parcels),
        total_delivered: finiteNonNegative(data?.total_delivered),
        total_cancel: finiteNonNegative(data?.total_cancel),
        provider_status: boundedText(data?.provider_status),
        customer_tag: boundedText(data?.customer_tag),
        success_rate: finiteNonNegative(data?.success_rate),
        cancel_rate: finiteNonNegative(data?.cancel_rate),
        riskLevel: riskLevel ?? "unknown",
        ...(Object.keys(apis).length > 0 ? { apis } : {}),
    };
}

// ── List Providers ──

const fraudProviderSchema = z.object({
    id: z.string().max(100),
    name: z.string().max(100),
    apiUrl: z.string().max(2048),
    apiKey: z.string().max(20),
    apiSecret: z.string().max(20).optional(),
    userId: z.string().max(20).optional(),
    isActive: z.boolean(),
    providerType: providerTypeSchema.optional(),
});

const listRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.fraud_providers.list",
    tags: ["Admin - Fraud Checker"],
    summary: "List all fraud checker providers",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(FRAUD_PROVIDER_PAGE_LIMIT).default(FRAUD_PROVIDER_PAGE_LIMIT),
        }),
    },
    responses: {
        200: { description: "Provider list", content: { "application/json": { schema: successEnvelope(z.object({
            providers: z.array(fraudProviderSchema).max(FRAUD_PROVIDER_PAGE_LIMIT),
            pagination: z.object({
                page: z.number().int().min(1),
                limit: z.number().int().min(1).max(FRAUD_PROVIDER_PAGE_LIMIT),
                hasMore: z.boolean(),
            }),
        })) } } },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const { page, limit } = c.req.valid("query");
    const providerRows = await getFraudProviders(
        db,
        getCredentialEncryptionKey(c.env as Record<string, unknown>),
        { limit: limit + 1, offset: (page - 1) * limit },
    );
    const providers = providerRows.slice(0, limit);

    const maskedProviders = providers.map(maskProviderSecrets);

    return ok(c, {
        providers: maskedProviders,
        pagination: { page, limit, hasMore: providerRows.length > limit },
    });
});

// ── Create Provider ──

const createProviderSchema = z.object({
    name: z.string().min(1).max(100),
    apiUrl: secureProviderUrlSchema,
    apiKey: z.string().min(1).max(4096),
    apiSecret: z.string().max(4096).optional(),
    userId: z.string().max(4096).optional(),
    isActive: z.boolean().optional().default(true),
    providerType: providerTypeSchema.optional().default("default"),
});

const createProviderRoute = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.fraud_providers.create",
    tags: ["Admin - Fraud Checker"],
    summary: "Create a fraud checker provider",
    request: {
        body: { content: { "application/json": { schema: createProviderSchema } } }
    },
    responses: {
        201: { description: "Provider created", content: { "application/json": { schema: successEnvelope(fraudProviderSchema) } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
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
    name: z.string().min(1).max(100),
    apiUrl: secureProviderUrlSchema,
    apiKey: z.string().min(1).max(4096),
    apiSecret: z.string().max(4096).optional(),
    userId: z.string().max(4096).optional(),
    isActive: z.boolean().default(true),
    providerType: providerTypeSchema.optional().default("default"),
});

const updateProviderRoute = createRoute({
    method: "put",
    path: "/",
    operationId: "dashboard.fraud_providers.update",
    tags: ["Admin - Fraud Checker"],
    summary: "Update a fraud checker provider",
    request: {
        body: { content: { "application/json": { schema: updateProviderSchema } } }
    },
    responses: {
        200: { description: "Provider updated", content: { "application/json": { schema: successEnvelope(fraudProviderSchema) } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(updateProviderRoute, async (c) => {
    const db = c.get("db");
    const validated = c.req.valid("json");
    const env = c.env as Record<string, unknown>;
    const readKey = getCredentialEncryptionKey(env);
    const encryptionKey = requireEncryptionKey(env);
    let apiKey = validated.apiKey;
    let apiSecret = validated.apiSecret;
    const maskedCredentialMessage = "Masked fraud checker credentials could not be restored. Re-enter credentials before saving.";
    let userId = validated.userId;
    const existingProvider = apiKey === MASKED_VALUE || apiSecret === MASKED_VALUE || userId === MASKED_VALUE
        ? await getFraudProvider(db, validated.id, readKey)
        : null;

    if (apiKey === MASKED_VALUE) {
        if (existingProvider?.apiKey) {
            apiKey = existingProvider.apiKey;
        } else {
            throw new ValidationError(maskedCredentialMessage);
        }
    }

    if (apiSecret === MASKED_VALUE) {
        if (existingProvider?.apiSecret) {
            apiSecret = existingProvider.apiSecret;
        } else {
            throw new ValidationError(maskedCredentialMessage);
        }
    }

    if (userId === MASKED_VALUE) {
        if (existingProvider?.userId) {
            userId = existingProvider.userId;
        } else {
            throw new ValidationError(maskedCredentialMessage);
        }
    }

    const savedProvider = await saveFraudProvider(db, { ...validated, apiKey, apiSecret, userId }, encryptionKey);

    const maskedResponse = maskProviderSecrets(savedProvider);

    return ok(c, maskedResponse);
});

// ── Delete Provider ──

const deleteProviderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.fraud_providers.delete",
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
    operationId: "dashboard.fraud_providers.test",
    tags: ["Admin - Fraud Checker"],
    summary: "Test a fraud checker provider connection",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Test result", content: { "application/json": { schema: successEnvelope(z.object({ success: z.boolean(), message: z.string() })) } } },
        ...errorResponses,
    }
});

app.openapi(testProviderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await testFraudProvider(db, id, getCredentialEncryptionKey(c.env as Record<string, unknown>));
    return ok(c, safeProviderTestResult(result));
});

// ── Lookup (phone) ──

const lookupSchema = z.object({
    phone: z.string().min(1).max(32),
});

const lookupResponseSchema = z.object({
    total_parcels: z.number().optional(),
    total_delivered: z.number().optional(),
    total_cancel: z.number().optional(),
    provider_status: z.string().optional(),
    customer_tag: z.string().optional(),
    success_rate: z.number().optional(),
    cancel_rate: z.number().optional(),
    riskLevel: z.enum(["low", "medium", "high", "unknown"]).optional(),
    apis: z.record(z.string(), z.object({
        total_parcels: z.number(),
        total_delivered_parcels: z.number(),
        total_cancelled_parcels: z.number(),
    })).optional(),
});

const lookupRoute = createRoute({
    method: "post",
    path: "/lookup",
    operationId: "dashboard.fraud_lookup.run",
    tags: ["Admin - Fraud Checker"],
    summary: "Lookup fraud data for a phone number",
    request: {
        body: { content: { "application/json": { schema: lookupSchema } } }
    },
    responses: {
        200: { description: "Lookup result", content: { "application/json": { schema: successEnvelope(lookupResponseSchema) } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(lookupRoute, async (c) => {
    const db = c.get("db");
    const { phone } = c.req.valid("json");
    const result = await fraudLookupWithActiveProvider(db, phone, getCredentialEncryptionKey(c.env as Record<string, unknown>));
    return ok(c, projectFraudLookupResult(
        result.data as Record<string, unknown> | undefined,
        result.riskLevel,
    ));
});

export { app as adminFraudCheckerRoutes };
