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
    "clientSecret",
    "password",
    "apiKey",
    "secretKey",
    "webhookSecret",
] as const;
const DELIVERY_PROVIDER_CACHE_GROUPS = ["checkout"] as const;
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

async function maskCredentialsForClient(credentialsJson: string, env: Record<string, unknown>): Promise<string> {
    try {
        const credentials = parseJsonObject(await decryptStoredCredentials(credentialsJson, env));
        const masked = { ...credentials };

        for (const key of SENSITIVE_CREDENTIAL_KEYS) {
            if (masked[key]) masked[key] = MASKED_VALUE;
        }

        return JSON.stringify(masked);
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
        ? await maskCredentialsForClient(provider.credentials, env).catch(() => "{}")
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
        ...provider,
        createdAt: requiredTimestampForClient(provider.createdAt),
        updatedAt: requiredTimestampForClient(provider.updatedAt),
        lastTestAttemptAt: timestampForClient(provider.lastTestAttemptAt),
        lastTestSuccessAt: timestampForClient(provider.lastTestSuccessAt),
        lastTestFailureAt: timestampForClient(provider.lastTestFailureAt),
        credentials: maskedCredentials,
        readiness: {
            ...readiness,
            canCreateShipment: readiness.active,
            lastTestAttemptAt: timestampForClient(readiness.lastTestAttemptAt),
            lastTestSuccessAt: timestampForClient(readiness.lastTestSuccessAt),
            lastTestFailureAt: timestampForClient(readiness.lastTestFailureAt),
        },
    };
}

// ── List Providers ──

const deliveryProviderSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    credentials: z.string(),
    config: z.string(),
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
        }).passthrough()),
        activationBlockers: z.array(z.object({
            source: z.string(),
            key: z.string(),
            label: z.string(),
            message: z.string(),
        }).passthrough()),
    }).passthrough().optional(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
}).passthrough();

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Delivery Providers"],
    summary: "List all delivery providers",
    responses: {
        200: { description: "Provider list", content: { "application/json": { schema: successEnvelope(z.array(deliveryProviderSchema)) } } },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const providers = await getDeliveryProviders(db);
    const env = c.env as Record<string, unknown>;
    const maskedProviders = await Promise.all(providers.map((provider) => serializeProviderForClient(provider, env)));

    return ok(c, maskedProviders);
});

// ── Create Provider ──

const createDeliveryProviderSchema = z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    credentials: z.union([z.string(), z.record(z.string(), z.unknown())]),
    config: z.union([z.string(), z.record(z.string(), z.unknown())]),
    isActive: z.boolean().optional().default(false),
});

const createProviderRoute = createRoute({
    method: "post",
    path: "/",
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

const updateDeliveryProviderSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.string().min(1),
    credentials: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    config: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    isActive: z.boolean().optional(),
});

const updateProviderRoute = createRoute({
    method: "put",
    path: "/",
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

const createTestSchema = z.object({
    type: z.string().min(1),
    credentials: z.union([z.string(), z.record(z.string(), z.unknown())]),
    config: z.union([z.string(), z.record(z.string(), z.unknown())]),
    name: z.string().optional().default("Test Provider"),
});

const testResultSchema = z.object({
    success: z.boolean(),
    message: z.string().optional(),
}).passthrough();

const createTestRoute = createRoute({
    method: "post",
    path: "/create-test",
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

        return ok(c, {
            ...result,
            provider: { type, name, credentials: "...", config: "..." }
        });
    } catch (error: unknown) {
        return ok(c, {
            success: false,
            message: error instanceof Error ? error.message : "Failed to test provider connection"
        });
    }
});

// ── Get Provider ──

const getProviderRoute = createRoute({
    method: "get",
    path: "/{id}",
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
    return ok(c, result);
});

// ── Delete Provider ──

const deleteProviderRoute = createRoute({
    method: "delete",
    path: "/{id}",
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
