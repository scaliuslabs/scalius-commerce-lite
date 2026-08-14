import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { getDeliveryProviders, getDeliveryProvider, saveDeliveryProvider, testDeliveryProvider } from "@scalius/core/modules/delivery/delivery.service";
import {
    assertDeliveryProviderReadyForActivation,
    getDeliveryProviderReadinessSummary,
    getDeliveryProviderSetupFingerprint,
} from "@scalius/core/modules/delivery/provider-readiness";
import { createProvider } from "@scalius/core/modules/delivery/factory";
import { deliveryProviders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { NotFoundError, ValidationError } from "../../../utils/api-error";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import { invalidateApiAndScheduleStorefrontGroups } from "../../../utils/cache-invalidation";

import { ok, created } from "../../../utils/api-response";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

const MASKED_VALUE = "••••••••••••";
const SENSITIVE_CREDENTIAL_KEYS = [
    "clientId",
    "clientSecret",
    "username",
    "password",
    "apiKey",
    "secretKey",
    "webhookSecret",
] as const;
const DELIVERY_PROVIDER_CACHE_GROUPS = ["checkout"] as const;
const DELIVERY_PROVIDER_PAGE_LIMIT = 10;
type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AppRouteContext<R extends RouteConfig> = Parameters<AppRouteHandler<R>>[0];

function parseJsonObject(value: string): Record<string, unknown> {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected a JSON object");
    }
    return parsed as Record<string, unknown>;
}

function stringifyJsonInput(value: string | Record<string, unknown> | undefined): string | undefined {
    if (value === undefined) return undefined;
    return typeof value === "string" ? value : JSON.stringify(value);
}

function safeProviderTestResult(result: { success?: unknown }): {
    success: boolean;
    message: string;
} {
    const success = result.success === true;
    return {
        success,
        message: success ? "Connection successful" : "Connection failed",
    };
}

async function decryptStoredCredentials(
    credentialsJson: string,
    env: Record<string, unknown>,
): Promise<string> {
    const read = await readStoredCredentialStrict(
        credentialsJson,
        getCredentialEncryptionKey(env),
        "Delivery provider credentials",
    );
    if (read.error) {
        throw new Error(read.error);
    }
    return read.value;
}

function hasMaskedCredential(credentials: Record<string, unknown>): boolean {
    return SENSITIVE_CREDENTIAL_KEYS.some((key) => credentials[key] === MASKED_VALUE);
}

async function credentialsForSave(
    newCredentials: string,
    existingCredentials?: string,
    env?: Record<string, unknown>,
): Promise<string> {
    try {
        const newCreds = parseJsonObject(newCredentials);
        if (!existingCredentials || !hasMaskedCredential(newCreds)) {
            return JSON.stringify(newCreds);
        }

        if (!env) {
            throw new ValidationError("Existing delivery provider credentials could not be read. Re-enter credentials before saving.");
        }
        const existingCreds = parseJsonObject(await decryptStoredCredentials(existingCredentials, env));
        const unmasked = { ...newCreds };

        for (const key of SENSITIVE_CREDENTIAL_KEYS) {
            if (unmasked[key] !== MASKED_VALUE) continue;
            const existingValue = existingCreds[key];
            if (typeof existingValue !== "string" || !existingValue) {
                throw new ValidationError("Masked delivery provider credentials could not be restored. Re-enter credentials before saving.");
            }
            unmasked[key] = existingValue;
        }

        return JSON.stringify(unmasked);
    } catch (error) {
        if (error instanceof ValidationError) throw error;
        return newCredentials;
    }
}

async function existingCredentialsForSave(
    credentialsJson: string,
    env: Record<string, unknown>,
): Promise<string> {
    try {
        return JSON.stringify(parseJsonObject(await decryptStoredCredentials(credentialsJson, env)));
    } catch {
        throw new ValidationError("Existing delivery provider credentials could not be read. Re-enter credentials before saving.");
    }
}

function projectProviderCredentials(
    type: string,
    credentials: Record<string, unknown>,
): Record<string, string> {
    const keys = type === "pathao"
        ? ["baseUrl", "clientId", "clientSecret", "username", "password", "webhookSecret"]
        : type === "steadfast"
            ? ["baseUrl", "apiKey", "secretKey", "webhookSecret"]
            : ["baseUrl"];
    return Object.fromEntries(keys.flatMap((key) => {
        const value = credentials[key];
        if (typeof value !== "string") return [];
        return [[key, key === "baseUrl" ? value.slice(0, 2048) : value ? MASKED_VALUE : ""]];
    }));
}

function projectProviderConfig(type: string, configJson: string): string {
    try {
        const config = parseJsonObject(configJson);
        if (type === "pathao") {
            return JSON.stringify({
                storeId: typeof config.storeId === "string" ? config.storeId.slice(0, 100) : "",
                defaultDeliveryType: Number.isFinite(Number(config.defaultDeliveryType)) ? Number(config.defaultDeliveryType) : 48,
                defaultItemType: Number.isFinite(Number(config.defaultItemType)) ? Number(config.defaultItemType) : 2,
                defaultItemWeight: Number.isFinite(Number(config.defaultItemWeight)) ? Number(config.defaultItemWeight) : 0.5,
            });
        }
        if (type === "steadfast") {
            return JSON.stringify({
                defaultCodAmount: Number.isFinite(Number(config.defaultCodAmount)) ? Number(config.defaultCodAmount) : 0,
            });
        }
        return "{}";
    } catch {
        return "{}";
    }
}

async function maskCredentialsForClient(
    type: string,
    credentialsJson: string,
    env: Record<string, unknown>,
): Promise<string> {
    try {
        const credentials = parseJsonObject(await decryptStoredCredentials(credentialsJson, env));
        return JSON.stringify(projectProviderCredentials(type, credentials));
    } catch {
        return "{}";
    }
}

type DeliveryProviderRouteRecord = NonNullable<Awaited<ReturnType<typeof getDeliveryProvider>>>;

function timestampForClient(value: Date | number | string | null | undefined): string | number | null {
    if (value instanceof Date) return value.toISOString();
    return value ?? null;
}

function requiredTimestampForClient(value: Date | number | string): string | number {
    if (value instanceof Date) return value.toISOString();
    return value;
}

async function serializeProviderForClient(
    provider: DeliveryProviderRouteRecord,
    env: Record<string, unknown>,
) {
    const credentialsForReadiness = await decryptStoredCredentials(provider.credentials, env).catch(() => null);
    const maskedCredentials = credentialsForReadiness
        ? await maskCredentialsForClient(provider.type, provider.credentials, env).catch(() => "{}")
        : "{}";

    let currentFingerprint: string | null = null;
    const fingerprintKey = env.CREDENTIAL_ENCRYPTION_KEY as string | undefined;
    if (fingerprintKey && credentialsForReadiness) {
        try {
            currentFingerprint = await getDeliveryProviderSetupFingerprint({
                type: provider.type,
                credentials: credentialsForReadiness,
                config: provider.config,
            }, fingerprintKey);
        } catch { /* unreadable setup remains untested */ }
    }

    const readiness = getDeliveryProviderReadinessSummary({
        type: provider.type,
        credentials: credentialsForReadiness,
        config: provider.config,
        isActive: provider.isActive,
        currentFingerprint,
        lastTestAttemptAt: provider.lastTestAttemptAt,
        lastTestSuccessAt: provider.lastTestSuccessAt,
        lastTestFailureAt: provider.lastTestFailureAt,
        lastTestSuccessFingerprint: provider.lastTestSuccessFingerprint,
    });

    return {
        id: provider.id.slice(0, 100),
        name: provider.name.slice(0, 100),
        type: provider.type.slice(0, 50),
        isActive: provider.isActive,
        credentials: maskedCredentials,
        config: projectProviderConfig(provider.type, provider.config),
        createdAt: requiredTimestampForClient(provider.createdAt),
        updatedAt: requiredTimestampForClient(provider.updatedAt),
        readiness: {
            status: readiness.status,
            configured: readiness.configured,
            tested: readiness.tested,
            active: readiness.active,
            canCreateShipment: readiness.active,
            blockers: readiness.blockers.slice(0, 20).map((blocker) => ({
                code: blocker.code.slice(0, 100),
                message: blocker.message.slice(0, 500),
            })),
            activationBlockers: readiness.activationBlockers.slice(0, 20).map((blocker) => ({
                source: blocker.source.slice(0, 100),
                key: blocker.key.slice(0, 100),
                label: blocker.label.slice(0, 100),
                message: blocker.message.slice(0, 500),
            })),
            lastTestAttemptAt: timestampForClient(readiness.lastTestAttemptAt),
            lastTestSuccessAt: timestampForClient(readiness.lastTestSuccessAt),
            lastTestFailureAt: timestampForClient(readiness.lastTestFailureAt),
        },
    };
}

// ── List Providers ──

const deliveryProviderSchema = z.object({
    id: z.string().max(100),
    name: z.string().max(100),
    type: z.string().max(50),
    credentials: z.string().max(4096),
    config: z.string().max(4096),
    isActive: z.boolean(),
    readiness: z.object({
        status: z.enum(["draft", "configured", "tested", "active", "blocked"]),
        configured: z.boolean(),
        tested: z.boolean(),
        active: z.boolean(),
        canCreateShipment: z.boolean(),
        blockers: z.array(z.object({
            code: z.string(),
            message: z.string(),
        })),
        activationBlockers: z.array(z.object({
            source: z.string(),
            key: z.string(),
            label: z.string(),
            message: z.string(),
        })),
        lastTestAttemptAt: z.union([z.string(), z.number()]).nullable().optional(),
        lastTestSuccessAt: z.union([z.string(), z.number()]).nullable().optional(),
        lastTestFailureAt: z.union([z.string(), z.number()]).nullable().optional(),
    }).optional(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
});

const listRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.delivery_providers.list",
    tags: ["Admin - Delivery Providers"],
    summary: "List all delivery providers",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(DELIVERY_PROVIDER_PAGE_LIMIT).default(DELIVERY_PROVIDER_PAGE_LIMIT),
        }),
    },
    responses: {
        200: { description: "Provider list", content: { "application/json": { schema: successEnvelope(z.object({
            providers: z.array(deliveryProviderSchema).max(DELIVERY_PROVIDER_PAGE_LIMIT),
            pagination: z.object({
                page: z.number().int().min(1),
                limit: z.number().int().min(1).max(DELIVERY_PROVIDER_PAGE_LIMIT),
                hasMore: z.boolean(),
            }),
        })) } } },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const { page, limit } = c.req.valid("query");
    const providerRows = await getDeliveryProviders(db, { limit: limit + 1, offset: (page - 1) * limit });
    const providers = providerRows.slice(0, limit);
    const env = c.env as Record<string, unknown>;
    const maskedProviders = await Promise.all(providers.map((provider) => serializeProviderForClient(provider, env)));

    return ok(c, {
        providers: maskedProviders,
        pagination: { page, limit, hasMore: providerRows.length > limit },
    });
});

// ── Create Provider ──

const encodedProviderObjectSchema = z.string().max(32_768).describe(
    "Legacy JSON-encoded object accepted for dashboard compatibility; CLI and MCP callers should send the typed object variant.",
);
const pathaoCredentialsSchema = z.object({
    baseUrl: z.string().max(2_048).optional().describe("Optional Pathao API origin; defaults to https://api-hermes.pathao.com."),
    clientId: z.string().max(512).optional().describe("Pathao client ID; required before activation."),
    clientSecret: z.string().max(2_048).optional().describe("Pathao client secret; required before activation."),
    username: z.string().max(320).optional().describe("Pathao account username; required before activation."),
    password: z.string().max(2_048).optional().describe("Pathao account password; required before activation."),
    webhookSecret: z.string().max(512).optional().describe("Optional shared secret used to verify Pathao webhooks."),
}).strict();
const pathaoConfigSchema = z.object({
    storeId: z.string().max(100).optional().describe("Pathao store ID; required before activation."),
    defaultDeliveryType: z.union([z.literal(48), z.literal(12)]).optional().describe("48 for normal delivery or 12 for on-demand delivery; defaults to 48."),
    defaultItemType: z.union([z.literal(2), z.literal(1)]).optional().describe("2 for parcel or 1 for document; defaults to 2."),
    defaultItemWeight: z.number().min(0.1).max(50).optional().describe("Default parcel weight in kilograms; defaults to 0.5."),
}).strict();
const steadfastCredentialsSchema = z.object({
    baseUrl: z.string().max(2_048).optional().describe("Optional Steadfast API origin; defaults to https://portal.steadfast.com.bd/api/v1."),
    apiKey: z.string().max(2_048).optional().describe("Steadfast API key; required before activation."),
    secretKey: z.string().max(2_048).optional().describe("Steadfast secret key; required before activation."),
    webhookSecret: z.string().max(512).optional().describe("Optional shared secret used to verify Steadfast webhooks."),
}).strict();
const steadfastConfigSchema = z.object({
    defaultCodAmount: z.number().min(0).max(1_000_000_000).optional().describe("Default cash-on-delivery amount; defaults to 0."),
}).strict();

const providerObjectInput = <T extends z.ZodTypeAny>(schema: T) =>
    z.union([encodedProviderObjectSchema, schema]);

const createDeliveryProviderSchema = z.discriminatedUnion("type", [
    z.object({
        name: z.string().min(1).max(100),
        type: z.literal("pathao"),
        credentials: providerObjectInput(pathaoCredentialsSchema),
        config: providerObjectInput(pathaoConfigSchema),
        isActive: z.boolean().optional().default(false),
    }),
    z.object({
        name: z.string().min(1).max(100),
        type: z.literal("steadfast"),
        credentials: providerObjectInput(steadfastCredentialsSchema),
        config: providerObjectInput(steadfastConfigSchema),
        isActive: z.boolean().optional().default(false),
    }),
]);

const createProviderRoute = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.delivery_providers.create",
    tags: ["Admin - Delivery Providers"],
    summary: "Create a delivery provider",
    request: {
        body: { content: { "application/json": { schema: createDeliveryProviderSchema } } }
    },
    responses: {
        201: { description: "Provider created", content: { "application/json": { schema: successEnvelope(deliveryProviderSchema) } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(createProviderRoute, (async (c: AppRouteContext<typeof createProviderRoute>) => {
    const db = c.get("db");
    const validated = c.req.valid("json");
    const env = c.env as Record<string, unknown>;
    const encryptionKey = requireEncryptionKey(env);
    const credentials = stringifyJsonInput(validated.credentials) ?? "{}";
    const config = stringifyJsonInput(validated.config) ?? "{}";

    if (validated.isActive) {
        assertDeliveryProviderReadyForActivation({
            type: validated.type,
            credentials,
            config,
        });
    }

    const provider = {
        id: "",
        name: validated.name,
        type: validated.type,
        isActive: validated.isActive,
        credentials,
        config,
    };

    const savedProvider = await saveDeliveryProvider(db, provider, encryptionKey);
    const reloadedProvider = await getDeliveryProvider(db, savedProvider.id);
    if (!reloadedProvider) throw new NotFoundError("Provider not found after save");
    const maskedResponse = await serializeProviderForClient(reloadedProvider, env);

    await invalidateApiAndScheduleStorefrontGroups(DELIVERY_PROVIDER_CACHE_GROUPS, c);
    return created(c, maskedResponse);
}) as unknown as AppRouteHandler<typeof createProviderRoute>);

// ── Update Provider ──

const updateDeliveryProviderSchema = z.discriminatedUnion("type", [
    z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        type: z.literal("pathao"),
        credentials: providerObjectInput(pathaoCredentialsSchema).optional(),
        config: providerObjectInput(pathaoConfigSchema).optional(),
        isActive: z.boolean().optional(),
    }),
    z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        type: z.literal("steadfast"),
        credentials: providerObjectInput(steadfastCredentialsSchema).optional(),
        config: providerObjectInput(steadfastConfigSchema).optional(),
        isActive: z.boolean().optional(),
    }),
]);

const updateProviderRoute = createRoute({
    method: "put",
    path: "/",
    operationId: "dashboard.delivery_providers.update",
    tags: ["Admin - Delivery Providers"],
    summary: "Update a delivery provider",
    request: {
        body: { content: { "application/json": { schema: updateDeliveryProviderSchema } } }
    },
    responses: {
        200: { description: "Provider updated", content: { "application/json": { schema: successEnvelope(deliveryProviderSchema) } } },
        201: { description: "Provider created", content: { "application/json": { schema: successEnvelope(deliveryProviderSchema) } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(updateProviderRoute, (async (c: AppRouteContext<typeof updateProviderRoute>) => {
    const db = c.get("db");
    const validated = c.req.valid("json");
    const env = c.env as Record<string, unknown>;
    const encryptionKey = requireEncryptionKey(env);
    const credentials = stringifyJsonInput(validated.credentials);
    const config = stringifyJsonInput(validated.config);

    const existingProvider = await getDeliveryProvider(db, validated.id);
    if (!existingProvider) {
        const isActive = validated.isActive ?? false;
        const providerCredentials = credentials || "{}";
        const providerConfig = config || "{}";
        if (isActive) {
            assertDeliveryProviderReadyForActivation({
                type: validated.type,
                credentials: providerCredentials,
                config: providerConfig,
            });
        }

        const savedProvider = await saveDeliveryProvider(db, {
            id: validated.id,
            name: validated.name,
            type: validated.type,
            isActive,
            credentials: providerCredentials,
            config: providerConfig,
        }, encryptionKey);
        const reloadedProvider = await getDeliveryProvider(db, savedProvider.id);
        if (!reloadedProvider) throw new NotFoundError("Provider not found after save");
        const maskedResponse = await serializeProviderForClient(reloadedProvider, env);
        await invalidateApiAndScheduleStorefrontGroups(DELIVERY_PROVIDER_CACHE_GROUPS, c);
        return created(c, maskedResponse);
    }

    const providerCredentials = credentials ?? await existingCredentialsForSave(existingProvider.credentials, env);
    const existingCredentials = typeof existingProvider.credentials === 'string'
        ? existingProvider.credentials
        : JSON.stringify(existingProvider.credentials);
    const unmaskedCreds = await credentialsForSave(providerCredentials, existingCredentials, env);
    const nextConfig = config || (typeof existingProvider.config === 'string' ? existingProvider.config : JSON.stringify(existingProvider.config));
    const nextIsActive = validated.isActive !== undefined ? validated.isActive : existingProvider.isActive;

    if (nextIsActive) {
        assertDeliveryProviderReadyForActivation({
            type: validated.type,
            credentials: unmaskedCreds,
            config: nextConfig,
        });
    }

    const savedProvider = await saveDeliveryProvider(db, {
        id: validated.id,
        name: validated.name,
        type: validated.type,
        isActive: nextIsActive,
        credentials: unmaskedCreds,
        config: nextConfig,
    }, encryptionKey);

    const reloadedProvider = await getDeliveryProvider(db, savedProvider.id);
    if (!reloadedProvider) throw new NotFoundError("Provider not found after save");
    const maskedResponse = await serializeProviderForClient(reloadedProvider, env);

    await invalidateApiAndScheduleStorefrontGroups(DELIVERY_PROVIDER_CACHE_GROUPS, c);
    return ok(c, maskedResponse);
}) as unknown as AppRouteHandler<typeof updateProviderRoute>);

// ── Create Test Provider ──

const createTestSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("pathao"),
        credentials: providerObjectInput(pathaoCredentialsSchema),
        config: providerObjectInput(pathaoConfigSchema),
        name: z.string().max(100).optional().default("Test Provider"),
    }),
    z.object({
        type: z.literal("steadfast"),
        credentials: providerObjectInput(steadfastCredentialsSchema),
        config: providerObjectInput(steadfastConfigSchema),
        name: z.string().max(100).optional().default("Test Provider"),
    }),
]);

const testResultSchema = z.object({
    success: z.boolean(),
    message: z.string(),
});

const createTestRoute = createRoute({
    method: "post",
    path: "/create-test",
    operationId: "dashboard.delivery_providers.test_credentials",
    tags: ["Admin - Delivery Providers"],
    summary: "Test a new provider connection before saving",
    request: {
        body: { content: { "application/json": { schema: createTestSchema } } }
    },
    responses: {
        200: { description: "Test result", content: { "application/json": { schema: successEnvelope(testResultSchema) } } },
        ...errorResponses,
    }
});

app.openapi(createTestRoute, async (c) => {
    const { type, credentials, config, name } = c.req.valid("json");

    assertDeliveryProviderReadyForActivation({ type, credentials, config });

    const mockProvider = {
        id: "test_" + Date.now().toString(),
        name,
        type,
        isActive: true,
        credentials: typeof credentials === "string" ? credentials : JSON.stringify(credentials),
        config: typeof config === "string" ? config : JSON.stringify(config),
        lastTestAttemptAt: null,
        lastTestSuccessAt: null,
        lastTestFailureAt: null,
        lastTestSuccessFingerprint: null,
        createdAt: new Date(),
        updatedAt: new Date()
    };

    try {
        const providerInstance = await createProvider(mockProvider, getCredentialEncryptionKey(c.env as Record<string, unknown>), c.get("db"));
        const result = await providerInstance.testConnection();

        return ok(c, safeProviderTestResult(result));
    } catch {
        return ok(c, safeProviderTestResult({ success: false }));
    }
});

// ── Get Provider ──

const getProviderRoute = createRoute({
    method: "get",
    path: "/{id}",
    operationId: "dashboard.delivery_providers.get",
    tags: ["Admin - Delivery Providers"],
    summary: "Get a delivery provider by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Provider details", content: { "application/json": { schema: successEnvelope(deliveryProviderSchema) } } },
        ...errorResponses,
    }
});

app.openapi(getProviderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const provider = await getDeliveryProvider(db, id);
    if (!provider) throw new NotFoundError("Provider not found");
    return ok(c, await serializeProviderForClient(provider, c.env as Record<string, unknown>));
});

// ── Test Existing Provider ──

const testExistingRoute = createRoute({
    method: "post",
    path: "/{id}",
    operationId: "dashboard.delivery_providers.test",
    tags: ["Admin - Delivery Providers"],
    summary: "Test an existing provider connection",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Test result", content: { "application/json": { schema: successEnvelope(testResultSchema) } } },
        ...errorResponses,
    }
});

app.openapi(testExistingRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const provider = await getDeliveryProvider(db, id);
    if (!provider) throw new NotFoundError("Provider not found");
    const result = await testDeliveryProvider(db, id, getCredentialEncryptionKey(c.env as Record<string, unknown>));
    await invalidateApiAndScheduleStorefrontGroups(DELIVERY_PROVIDER_CACHE_GROUPS, c);
    return ok(c, safeProviderTestResult(result));
});

// ── Delete Provider ──

const deleteProviderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.delivery_providers.delete",
    tags: ["Admin - Delivery Providers"],
    summary: "Delete a delivery provider",
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
    await db.delete(deliveryProviders).where(eq(deliveryProviders.id, id));
    await invalidateApiAndScheduleStorefrontGroups(DELIVERY_PROVIDER_CACHE_GROUPS, c);
    return ok(c, {});
});

export { app as deliveryProvidersRoutes };
