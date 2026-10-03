// src/server/routes/admin/fraud-checker.ts
// Admin OpenAPI routes for the fraud checkers: built-in checkers with their
// credentials, or an installed app's fraud provider (its credentials live in
// the app's settings), and the order page's manual lookup through the first
// active one. Advice for the merchant, never automatic blocking.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getFraudProviders,
    getFraudProvider,
    saveFraudProvider,
    deleteFraudProvider,
    testFraudProvider,
    fraudLookupWithActiveProvider,
    getFraudProviderUrlIssue,
} from "@scalius/core/modules/fraud-checker";
import { FRAUD_CHECK_PROVIDER_TYPES } from "@scalius/core/modules/fraud-checker/browser";
import { isQualifiedProviderId, type FraudCheck } from "@scalius/shared/plugins/providers";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../utils/encryption-key";
import { assertAppProviderInstalled, requestAppProviders } from "../../plugins/providers/app-providers";
import { NotFoundError, ValidationError } from "../../utils/api-error";

import { ok, created } from "../../utils/api-response";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const MASKED_VALUE = "••••••••••••";
const FRAUD_PROVIDER_PAGE_LIMIT = 20;
const providerTypeSchema = z.enum(FRAUD_CHECK_PROVIDER_TYPES);
/** An installed app's fraud provider (`<plugin id>:<provider id>`). */
const appProviderTypeSchema = z.string().max(160).refine(isQualifiedProviderId, "Name an app provider as <plugin id>:<provider id>.");

function safeProviderUrlForClient(value: string): string {
    return getFraudProviderUrlIssue(value) ? "" : new URL(value).toString();
}

function maskProviderSecrets(provider: {
    id: string;
    name: string;
    apiUrl: string;
    apiKey: string;
    apiSecret?: string;
    userId?: string;
    isActive: boolean;
    providerType?: string;
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
    const issue = getFraudProviderUrlIssue(value);
    if (issue) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: issue,
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

/** The fraud port's answer as the order page reads it, bounded. */
function projectFraudLookupResult(result: FraudCheck) {
    const rawCouriers = result.couriers && typeof result.couriers === "object" && !Array.isArray(result.couriers)
        ? result.couriers as Record<string, unknown>
        : {};
    const apis = Object.fromEntries(
        Object.entries(rawCouriers).slice(0, 20).flatMap(([provider, value]) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [];
            const row = value as Record<string, unknown>;
            return [[provider.slice(0, 80), {
                total_parcels: finiteNonNegative(row.totalParcels) ?? 0,
                total_delivered_parcels: finiteNonNegative(row.delivered) ?? 0,
                total_cancelled_parcels: finiteNonNegative(row.cancelled) ?? 0,
            }]];
        }),
    );

    return {
        total_parcels: finiteNonNegative(result.totalParcels),
        total_delivered: finiteNonNegative(result.delivered),
        total_cancel: finiteNonNegative(result.cancelled),
        provider_status: boundedText(result.providerStatus),
        customer_tag: boundedText(result.customerTag),
        success_rate: finiteNonNegative(result.successRate),
        cancel_rate: finiteNonNegative(result.cancelRate),
        riskLevel: result.riskLevel ?? "unknown",
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
    providerType: z.union([providerTypeSchema, appProviderTypeSchema]).optional(),
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

const createBuiltInProviderSchema = z.object({
    name: z.string().min(1).max(100),
    apiUrl: secureProviderUrlSchema,
    apiKey: z.string().min(1).max(4096),
    apiSecret: z.string().max(4096).optional(),
    userId: z.string().max(4096).optional(),
    isActive: z.boolean().optional().default(true),
    providerType: providerTypeSchema.optional().default("default"),
});

/** An app fraud provider: only which app and whether lookups use it; its credentials live in the app's settings. */
const appProviderRowSchema = z.object({
    name: z.string().min(1).max(100),
    isActive: z.boolean().optional().default(true),
    providerType: appProviderTypeSchema,
}).strict();

const createProviderSchema = z.union([createBuiltInProviderSchema, appProviderRowSchema]);

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
    const body = c.req.valid("json");
    const encryptionKey = requireEncryptionKey(c.env as Record<string, unknown>);

    const provider = "apiUrl" in body ? body : { ...body, apiUrl: "", apiKey: "" };
    if (isQualifiedProviderId(provider.providerType)) await assertAppProviderInstalled(db, "fraud", provider.providerType);
    const savedProvider = await saveFraudProvider(db, provider, encryptionKey);

    const maskedResponse = maskProviderSecrets(savedProvider);

    return created(c, maskedResponse);
});

// ── Update Provider ──

const updateBuiltInProviderSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    apiUrl: secureProviderUrlSchema,
    apiKey: z.string().min(1).max(4096),
    apiSecret: z.string().max(4096).optional(),
    userId: z.string().max(4096).optional(),
    isActive: z.boolean().default(true),
    providerType: providerTypeSchema.optional().default("default"),
});

const updateProviderSchema = z.union([
    updateBuiltInProviderSchema,
    appProviderRowSchema.extend({ id: z.string().min(1) }).strict(),
]);

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
    const body = c.req.valid("json");
    const env = c.env as Record<string, unknown>;
    if (!("apiUrl" in body)) {
        await assertAppProviderInstalled(db, "fraud", body.providerType);
        const saved = await saveFraudProvider(db, { ...body, apiUrl: "", apiKey: "" }, requireEncryptionKey(env));
        return ok(c, maskProviderSecrets(saved));
    }
    const validated = body;
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
    const result = await testFraudProvider(db, id, getCredentialEncryptionKey(c.env as Record<string, unknown>), requestAppProviders(c));
    return ok(c, safeProviderTestResult(result));
});

// ── Lookup (phone) ──

const lookupSchema = z.object({
    phone: z.string().min(1).max(32),
    /** The order's shipping country: a checker that does not know buyers there is not asked. */
    countryCode: z.string().trim().length(2).nullable().optional(),
});

const lookupResponseSchema = z.object({
    /** False when no courier fraud-check service is connected: a state, not an error. */
    configured: z.boolean(),
    /**
     * Set when the connected checker does not know buyers in this country
     * (MARKETS-DESIGN step 3a): it was not asked, and the order page says so.
     */
    unsupportedCountry: z.object({ provider: z.string(), countryCode: z.string().nullable() }).optional(),
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
    const { phone, countryCode } = c.req.valid("json");
    let result: Awaited<ReturnType<typeof fraudLookupWithActiveProvider>>;
    try {
        result = await fraudLookupWithActiveProvider(db, phone, getCredentialEncryptionKey(c.env as Record<string, unknown>), requestAppProviders(c), { countryCode });
    } catch (error: unknown) {
        if (error instanceof NotFoundError) return ok(c, { configured: false });
        throw error;
    }
    if (result.status === "country_unsupported") {
        return ok(c, { configured: true, unsupportedCountry: { provider: result.provider, countryCode: result.countryCode } });
    }
    return ok(c, {
        configured: true,
        ...projectFraudLookupResult(result.check),
    });
});

export { app as adminFraudCheckerRoutes };
