import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDeliveryProviders, getDeliveryProvider, saveDeliveryProvider } from "@scalius/core/modules/delivery/delivery.service";
import { createProvider } from "@scalius/core/modules/delivery/factory";
import { deliveryProviders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../../utils/api-error";
import { getEncryptionKey } from "../../../utils/encryption-key";

import { ok, created } from "../../../utils/api-response";
import { successEnvelope, errorResponses } from "../../../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

const MASKED_VALUE = "••••••••••••";

function unmaskedCredentials(
    newCredentials: string,
    existingCredentials?: string,
): string {
    try {
        const newCreds = JSON.parse(newCredentials);
        if (!existingCredentials) return newCredentials;

        const existingCreds = JSON.parse(existingCredentials);
        const unmasked = { ...newCreds };

        if (unmasked.clientSecret === MASKED_VALUE && existingCreds.clientSecret) unmasked.clientSecret = existingCreds.clientSecret;
        if (unmasked.password === MASKED_VALUE && existingCreds.password) unmasked.password = existingCreds.password;
        if (unmasked.apiKey === MASKED_VALUE && existingCreds.apiKey) unmasked.apiKey = existingCreds.apiKey;
        if (unmasked.secretKey === MASKED_VALUE && existingCreds.secretKey) unmasked.secretKey = existingCreds.secretKey;

        return JSON.stringify(unmasked);
    } catch {
        return newCredentials;
    }
}

function maskCredentialsForClient(credentialsJson: string): string {
    try {
        const credentials = JSON.parse(credentialsJson);
        const masked = { ...credentials };

        if (masked.clientSecret) masked.clientSecret = MASKED_VALUE;
        if (masked.password) masked.password = MASKED_VALUE;
        if (masked.apiKey) masked.apiKey = MASKED_VALUE;
        if (masked.secretKey) masked.secretKey = MASKED_VALUE;

        return JSON.stringify(masked);
    } catch {
        return credentialsJson;
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
    const maskedProviders = providers.map((provider) => ({
        ...provider,
        credentials: maskCredentialsForClient(provider.credentials)
    }));

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

app.openapi(createProviderRoute, (async (c: any) => {
    const db = c.get("db");
    const validated = c.req.valid("json");
    const credentials = typeof validated.credentials !== "string"
        ? JSON.stringify(validated.credentials)
        : validated.credentials;
    const config = typeof validated.config !== "string"
        ? JSON.stringify(validated.config)
        : validated.config;

    const provider = {
        id: "",
        name: validated.name,
        type: validated.type,
        isActive: validated.isActive,
        credentials,
        config,
    };

    const savedProvider = await saveDeliveryProvider(db, provider, getEncryptionKey(c.env as Record<string, unknown>));
    const savedCredentials = typeof savedProvider.credentials === 'string'
        ? savedProvider.credentials
        : JSON.stringify(savedProvider.credentials);
    const maskedResponse = {
        ...savedProvider,
        credentials: maskCredentialsForClient(savedCredentials)
    };

    return created(c, maskedResponse);
}) as any);

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

app.openapi(updateProviderRoute, (async (c: any) => {
    const db = c.get("db");
    const validated = c.req.valid("json");
    const credentials = validated.credentials && typeof validated.credentials !== "string"
        ? JSON.stringify(validated.credentials)
        : (validated.credentials as string | undefined);
    const config = validated.config && typeof validated.config !== "string"
        ? JSON.stringify(validated.config)
        : (validated.config as string | undefined);

    const existingProvider = await getDeliveryProvider(db, validated.id);
    if (!existingProvider) {
        const savedProvider = await saveDeliveryProvider(db, {
            id: validated.id,
            name: validated.name,
            type: validated.type,
            isActive: validated.isActive ?? true,
            credentials: credentials || "{}",
            config: config || "{}",
        }, getEncryptionKey(c.env as Record<string, unknown>));
        const newCredentials = typeof savedProvider.credentials === 'string'
            ? savedProvider.credentials
            : JSON.stringify(savedProvider.credentials);
        const maskedResponse = {
            ...savedProvider,
            credentials: maskCredentialsForClient(newCredentials)
        };
        return created(c, maskedResponse);
    }

    const providerCredentials = credentials || JSON.stringify(existingProvider.credentials);
    const existingCredentials = typeof existingProvider.credentials === 'string'
        ? existingProvider.credentials
        : JSON.stringify(existingProvider.credentials);
    const unmaskedCreds = unmaskedCredentials(providerCredentials, existingCredentials);

    const savedProvider = await saveDeliveryProvider(db, {
        id: validated.id,
        name: validated.name,
        type: validated.type,
        isActive: validated.isActive !== undefined ? validated.isActive : existingProvider.isActive,
        credentials: unmaskedCreds,
        config: config || (typeof existingProvider.config === 'string' ? existingProvider.config : JSON.stringify(existingProvider.config)),
    }, getEncryptionKey(c.env as Record<string, unknown>));

    const updatedCredentials = typeof savedProvider.credentials === 'string'
        ? savedProvider.credentials
        : JSON.stringify(savedProvider.credentials);
    const maskedResponse = {
        ...savedProvider,
        credentials: maskCredentialsForClient(updatedCredentials)
    };

    return ok(c, maskedResponse);
}) as any);

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
        credentials: maskCredentialsForClient(provider.credentials),
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
    return ok(c, {});
});

export { app as deliveryProvidersRoutes };
