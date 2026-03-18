import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DeliveryService } from "@scalius/core/modules/delivery/service";
import { createProvider } from "@scalius/core/modules/delivery/factory";
import { deliveryProviders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../../../utils/api-error";

import { ok, created } from "../../../utils/api-response";
const app = new OpenAPIHono();

const deliveryService = new DeliveryService();

const MASKED_VALUE = "••••••••••••";

/** Get encryption key — prefers CREDENTIAL_ENCRYPTION_KEY, falls back to JWT_SECRET */
function getEncryptionKey(env: Record<string, unknown>): string | undefined {
    return (env.CREDENTIAL_ENCRYPTION_KEY as string | undefined)
        ?? (env.JWT_SECRET as string | undefined);
}

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
    } catch (e: unknown) {
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
    } catch (e: unknown) {
        return credentialsJson;
    }
}

// ── List Providers ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Delivery Providers"],
    summary: "List all delivery providers",
    responses: { 200: { description: "Provider list"  } }
});

app.openapi(listRoute, async (c) => {
    try {
        const providers = await deliveryService.getProviders();
        const maskedProviders = providers.map((provider) => ({
            ...provider,
            credentials: maskCredentialsForClient(provider.credentials)
        }));

        return ok(c, maskedProviders);
    } catch (error: unknown) {
        throw error;
    }
});

// ── Create Provider ──

const createDeliveryProviderSchema = z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    credentials: z.any(),
    config: z.any(),
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
    responses: { 201: { description: "Provider created"  } }
});

app.openapi(createProviderRoute, async (c) => {
    try {
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

        const savedProvider = await deliveryService.saveProvider(provider, getEncryptionKey(c.env as Record<string, unknown>));
        const savedCredentials = typeof savedProvider.credentials === 'string'
            ? savedProvider.credentials
            : JSON.stringify(savedProvider.credentials);
        const maskedResponse = {
            ...savedProvider,
            credentials: maskCredentialsForClient(savedCredentials)
        };

        return created(c, maskedResponse);
    } catch (error: unknown) {
        throw error;
    }
});

// ── Update Provider ──

const updateDeliveryProviderSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.string().min(1),
    credentials: z.any().optional(),
    config: z.any().optional(),
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
    responses: { 200: { description: "Provider updated"  } }
});

app.openapi(updateProviderRoute, async (c) => {
    try {
        const validated = c.req.valid("json");
        const credentials = validated.credentials && typeof validated.credentials !== "string"
            ? JSON.stringify(validated.credentials)
            : (validated.credentials as string | undefined);
        const config = validated.config && typeof validated.config !== "string"
            ? JSON.stringify(validated.config)
            : (validated.config as string | undefined);

        const existingProvider = await deliveryService.getProvider(validated.id);
        if (!existingProvider) {
            const savedProvider = await deliveryService.saveProvider({
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

        const savedProvider = await deliveryService.saveProvider({
            id: validated.id,
            name: validated.name,
            type: validated.type,
            isActive: validated.isActive !== undefined ? validated.isActive : existingProvider.isActive,
            credentials: unmaskedCreds,
            config: config || (typeof existingProvider.config === 'string' ? existingProvider.config : JSON.stringify(existingProvider.config)),
        });

        const updatedCredentials = typeof savedProvider.credentials === 'string'
            ? savedProvider.credentials
            : JSON.stringify(savedProvider.credentials);
        const maskedResponse = {
            ...savedProvider,
            credentials: maskCredentialsForClient(updatedCredentials)
        };

        return ok(c, maskedResponse);
    } catch (error: unknown) {
        throw error;
    }
});

// ── Create Test Provider ──

const createTestSchema = z.object({
    type: z.string().min(1),
    credentials: z.any(),
    config: z.any(),
    name: z.string().optional().default("Test Provider"),
});

const createTestRoute = createRoute({
    method: "post",
    path: "/create-test",
    tags: ["Admin - Delivery Providers"],
    summary: "Test a new provider connection before saving",
    request: {
        body: { content: { "application/json": { schema: createTestSchema } } }
    },
    responses: { 200: { description: "Test result"  } }
});

app.openapi(createTestRoute, async (c) => {
    try {
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
            const providerInstance = await createProvider(mockProvider, getEncryptionKey(c.env as Record<string, unknown>));
            const result = await providerInstance.testConnection();

            return ok(c, {
                ...result,
                provider: { type, name, credentials: "...", config: "..." }
            });
        } catch (testError: unknown) {
            return ok(c, {
                success: false,
                message: testError instanceof Error ? testError.message : "Failed to test provider connection"
            });
        }
    } catch (error: unknown) {
        throw error;
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
    responses: { 200: { description: "Provider details"  } }
});

app.openapi(getProviderRoute, async (c) => {
    try {
        const { id } = c.req.valid("param");
        const provider = await deliveryService.getProvider(id);
        if (!provider) throw new NotFoundError("Provider not found");
        return ok(c, provider);
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "NotFoundError") throw error;
        throw error;
    }
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
    responses: { 200: { description: "Test result"  } }
});

app.openapi(testExistingRoute, async (c) => {
    try {
        const { id } = c.req.valid("param");
        const provider = await deliveryService.getProvider(id);
        if (!provider) throw new NotFoundError("Provider not found");

        try {
            const providerInstance = await createProvider(provider, getEncryptionKey(c.env as Record<string, unknown>));
            const result = await providerInstance.testConnection();
            return ok(c, result);
        } catch (testError: unknown) {
            return ok(c, {
                success: false,
                message: testError instanceof Error ? testError.message : "Failed to test provider connection"
            });
        }
    } catch (error: unknown) {
        if (error instanceof Error && error.name === "NotFoundError") throw error;
        throw error;
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
    responses: { 200: { description: "Provider deleted"  } }
});

app.openapi(deleteProviderRoute, async (c) => {
    try {
        const db = c.get("db");
        const { id } = c.req.valid("param");
        await db.delete(deliveryProviders).where(eq(deliveryProviders.id, id));
        return ok(c, {});
    } catch (error: unknown) {
        throw error;
    }
});

export { app as deliveryProvidersRoutes };
