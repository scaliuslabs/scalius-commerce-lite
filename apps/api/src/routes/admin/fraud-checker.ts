// src/server/routes/admin/fraud-checker.ts
// Admin OpenAPI routes for the fraud checkers: rows that name an installed
// app's fraud provider (its credentials live in the app's settings), and the
// order page's manual lookup through the first active one. Advice for the
// merchant, never automatic blocking.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getFraudProviders,
    saveFraudProvider,
    deleteFraudProvider,
    testFraudProvider,
    fraudLookupWithActiveProvider,
} from "@scalius/core/modules/fraud-checker";
import { isQualifiedProviderId, type FraudCheck } from "@scalius/shared/plugins/providers";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../utils/encryption-key";
import { assertAppProviderInstalled, requestAppProviders } from "../../plugins/providers/app-providers";
import { NotFoundError } from "../../utils/api-error";

import { ok, created } from "../../utils/api-response";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
const FRAUD_PROVIDER_PAGE_LIMIT = 20;
/** An installed app's fraud provider (`<plugin id>:<provider id>`). */
const appProviderTypeSchema = z.string().max(160).refine(isQualifiedProviderId, "Name an app provider as <plugin id>:<provider id>.");

/** The checker's answer: its merchant-safe message (the port's ProviderError or the app's readiness), bounded. */
function safeProviderTestResult(result: { success?: unknown; message?: unknown }) {
    const success = result.success === true;
    const message = typeof result.message === "string" && result.message.trim() ? result.message.trim().slice(0, 300) : null;
    return {
        success,
        message: message ?? (success ? "Connection successful" : "Connection failed"),
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
    isActive: z.boolean(),
    providerType: appProviderTypeSchema,
});

function projectProvider(provider: { id: string; name: string; isActive: boolean; providerType: string }) {
    return {
        id: provider.id.slice(0, 100),
        name: provider.name.slice(0, 100),
        isActive: provider.isActive,
        providerType: provider.providerType,
    };
}

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

    return ok(c, {
        providers: providers.map(projectProvider),
        pagination: { page, limit, hasMore: providerRows.length > limit },
    });
});

// ── Create Provider ──

/** A fraud checker row: which app provider and whether lookups use it; its credentials live in the app's settings. */
const createProviderSchema = z.object({
    name: z.string().min(1).max(100),
    isActive: z.boolean().optional().default(true),
    providerType: appProviderTypeSchema,
}).strict();

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

    await assertAppProviderInstalled(db, "fraud", body.providerType);
    return created(c, projectProvider(await saveFraudProvider(db, body, encryptionKey)));
});

// ── Update Provider ──

const updateProviderSchema = createProviderSchema.extend({ id: z.string().min(1) }).strict();

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
    await assertAppProviderInstalled(db, "fraud", body.providerType);
    return ok(c, projectProvider(await saveFraudProvider(db, body, requireEncryptionKey(c.env as Record<string, unknown>))));
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
    /**
     * Set when the connected checker's app cannot be used now (not installed,
     * not active, not set up): it was not asked, and the order page shows why.
     */
    unavailable: z.object({ provider: z.string().max(100), reason: z.string().max(300) }).optional(),
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
    if (result.status === "unavailable") {
        return ok(c, { configured: true, unavailable: { provider: result.provider.slice(0, 100), reason: result.reason.slice(0, 300) } });
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
