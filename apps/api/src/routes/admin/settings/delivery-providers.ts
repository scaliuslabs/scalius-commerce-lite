import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { getDeliveryProviders, getDeliveryProvider, saveDeliveryProvider } from "@scalius/core/modules/delivery/delivery.service";
import { createProvider } from "@scalius/core/modules/delivery/factory";
import { deliveryProviders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { decryptCredentialsGraceful } from "@scalius/core/utils/credential-encryption";
import { NotFoundError, ValidationError } from "../../../utils/api-error";
import { getEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import { invalidateApiAndScheduleStorefrontGroups } from "../../../utils/cache-invalidation";

import { ok, created } from "../../../utils/api-response";
import { successEnvelope, errorResponses } from "../../../schemas/responses";
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
    const primaryKey = getEncryptionKey(env);
    const primary = await decryptCredentialsGraceful(credentialsJson, primaryKey);
    try {
        parseJsonObject(primary);
        return primary;
    } catch {
        const legacyJwtKey = env.JWT_SECRET as string | undefined;
        if (legacyJwtKey && legacyJwtKey !== primaryKey) {
            const legacy = await decryptCredentialsGraceful(credentialsJson, legacyJwtKey);
            try {
                parseJsonObject(legacy);
                return legacy;
            } catch {
                return primary;
            }
        }
        return primary;
    }
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

// ── List Providers ──

const deliveryProviderSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    credentials: z.string(),
    config: z.string(),
    isActive: z.boolean(),
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
    const maskedProviders = await Promise.all(providers.map(async (provider) => ({
        ...provider,
        credentials: await maskCredentialsForClient(provider.credentials, env)
    })));

    return ok(c, maskedProviders);
});

// ── Create Provider ──

const createDeliveryProviderSchema = z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    credentials: z.union([z.string(), z.record(z.string(), z.unknown())]),
    config: z.union([z.string(), z.record(z.string(), z.unknown())]),
    isActive: z.boolean().optional().default(true),
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
    }
});

app.openapi(createProviderRoute, (async (c: AppRouteContext<typeof createProviderRoute>) => {
    const db = c.get("db");
    const validated = c.req.valid("json");
    const env = c.env as Record<string, unknown>;
    const encryptionKey = requireEncryptionKey(env);
    const credentials = stringifyJsonInput(validated.credentials) ?? "{}";
    const config = stringifyJsonInput(validated.config) ?? "{}";

    const provider = {
        id: "",
        name: validated.name,
        type: validated.type,
        isActive: validated.isActive,
        credentials,
        config,
    };

    const savedProvider = await saveDeliveryProvider(db, provider, encryptionKey);
    const savedCredentials = typeof savedProvider.credentials === 'string'
        ? savedProvider.credentials
        : JSON.stringify(savedProvider.credentials);
    const maskedResponse = {
        ...savedProvider,
        credentials: await maskCredentialsForClient(savedCredentials, env)
    };

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
        ...errorResponses,
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
        const savedProvider = await saveDeliveryProvider(db, {
            id: validated.id,
            name: validated.name,
            type: validated.type,
            isActive: validated.isActive ?? true,
            credentials: credentials || "{}",
            config: config || "{}",
        }, encryptionKey);
        const newCredentials = typeof savedProvider.credentials === 'string'
            ? savedProvider.credentials
            : JSON.stringify(savedProvider.credentials);
        const maskedResponse = {
            ...savedProvider,
            credentials: await maskCredentialsForClient(newCredentials, env)
        };
        await invalidateApiAndScheduleStorefrontGroups(DELIVERY_PROVIDER_CACHE_GROUPS, c);
        return created(c, maskedResponse);
    }

    const providerCredentials = credentials ?? await existingCredentialsForSave(existingProvider.credentials, env);
    const existingCredentials = typeof existingProvider.credentials === 'string'
        ? existingProvider.credentials
        : JSON.stringify(existingProvider.credentials);
    const unmaskedCreds = await credentialsForSave(providerCredentials, existingCredentials, env);

    const savedProvider = await saveDeliveryProvider(db, {
        id: validated.id,
        name: validated.name,
        type: validated.type,
        isActive: validated.isActive !== undefined ? validated.isActive : existingProvider.isActive,
        credentials: unmaskedCreds,
        config: config || (typeof existingProvider.config === 'string' ? existingProvider.config : JSON.stringify(existingProvider.config)),
    }, encryptionKey);

    const updatedCredentials = typeof savedProvider.credentials === 'string'
        ? savedProvider.credentials
        : JSON.stringify(savedProvider.credentials);
    const maskedResponse = {
        ...savedProvider,
        credentials: await maskCredentialsForClient(updatedCredentials, env)
    };

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
        createdAt: new Date(),
        updatedAt: new Date()
    };

    try {
        const providerInstance = await createProvider(mockProvider, getEncryptionKey(c.env as Record<string, unknown>), c.get("db"));
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
    return ok(c, {
        ...provider,
        credentials: await maskCredentialsForClient(provider.credentials, c.env as Record<string, unknown>),
    });
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

    try {
        const providerInstance = await createProvider(provider, getEncryptionKey(c.env as Record<string, unknown>), db);
        const result = await providerInstance.testConnection();
        return ok(c, result);
    } catch (error: unknown) {
        return ok(c, {
            success: false,
            message: error instanceof Error ? error.message : "Failed to test provider connection"
        });
    }
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
