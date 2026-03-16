import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DeliveryService } from "@scalius/core/modules/delivery/service";
import { createProvider } from "@scalius/core/modules/delivery/factory";
import { db } from "@scalius/database/client";
import { deliveryProviders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../../utils/api-error";

import { ok, created } from "../../../utils/api-response";
const app = new OpenAPIHono();

const deliveryService = new DeliveryService();

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
    } catch (e) {
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
    } catch (e) {
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
        return c.json({ error: error instanceof Error ? error.message : "Failed to fetch providers" }, 500);
    }
});

// ── Create Provider ──

const createProviderRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Delivery Providers"],
    summary: "Create a delivery provider",
    responses: { 201: { description: "Provider created"  } }
});

app.openapi(createProviderRoute, async (c) => {
    try {
        const provider = await c.req.json();

        if (!provider.name || !provider.type) {
            return c.json({ error: "Missing required fields", required: ["name", "type"] }, 400);
        }

        if (typeof provider.credentials !== "string") {
            provider.credentials = JSON.stringify(provider.credentials);
        }
        if (typeof provider.config !== "string") {
            provider.config = JSON.stringify(provider.config);
        }

        const savedProvider = await deliveryService.saveProvider(provider);
        const credentials = typeof savedProvider.credentials === 'string'
            ? savedProvider.credentials
            : JSON.stringify(savedProvider.credentials);
        const maskedResponse = {
            ...savedProvider,
            credentials: maskCredentialsForClient(credentials)
        };

        return created(c, maskedResponse);
    } catch (error: unknown) {
        return c.json({ error: error instanceof Error ? error.message : "Failed to create provider" }, 500);
    }
});

// ── Update Provider ──

const updateProviderRoute = createRoute({
    method: "put",
    path: "/",
    tags: ["Admin - Delivery Providers"],
    summary: "Update a delivery provider",
    responses: { 200: { description: "Provider updated"  } }
});

app.openapi(updateProviderRoute, async (c) => {
    try {
        const provider = await c.req.json();

        if (!provider.id || !provider.name || !provider.type) {
            return c.json({ error: "Missing required fields", required: ["id", "name", "type"] }, 400);
        }

        if (provider.credentials && typeof provider.credentials !== "string") {
            provider.credentials = JSON.stringify(provider.credentials);
        }
        if (provider.config && typeof provider.config !== "string") {
            provider.config = JSON.stringify(provider.config);
        }

        const existingProvider = await deliveryService.getProvider(provider.id);
        if (!existingProvider) {
            const savedProvider = await deliveryService.saveProvider(provider);
            const newCredentials = typeof savedProvider.credentials === 'string'
                ? savedProvider.credentials
                : JSON.stringify(savedProvider.credentials);
            const maskedResponse = {
                ...savedProvider,
                credentials: maskCredentialsForClient(newCredentials)
            };
            return created(c, maskedResponse);
        }

        const providerCredentials = typeof provider.credentials === 'string'
            ? provider.credentials
            : JSON.stringify(provider.credentials);
        const existingCredentials = typeof existingProvider.credentials === 'string'
            ? existingProvider.credentials
            : JSON.stringify(existingProvider.credentials);
        const unmaskedCreds = unmaskedCredentials(providerCredentials, existingCredentials);

        const savedProvider = await deliveryService.saveProvider({
            ...provider,
            credentials: unmaskedCreds,
            id: provider.id,
            name: provider.name,
            type: provider.type,
            isActive: provider.isActive !== undefined ? provider.isActive : existingProvider.isActive
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
        return c.json({ error: error instanceof Error ? error.message : "Failed to update provider" }, 500);
    }
});

// ── Create Test Provider ──

const createTestRoute = createRoute({
    method: "post",
    path: "/create-test",
    tags: ["Admin - Delivery Providers"],
    summary: "Test a new provider connection before saving",
    responses: { 200: { description: "Test result"  } }
});

app.openapi(createTestRoute, async (c) => {
    try {
        const data = await c.req.json();
        const { type, credentials, config, name = "Test Provider" } = data;

        if (!type) return c.json({ error: "Provider type is required" }, 400);
        if (!credentials) return c.json({ error: "Provider credentials are required" }, 400);
        if (!config) return c.json({ error: "Provider config is required" }, 400);

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
            const providerInstance = await createProvider(mockProvider);
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
        return c.json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
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
        return c.json({ error: error instanceof Error ? error.message : "Failed to get provider" }, 500);
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
            const providerInstance = await createProvider(provider);
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
        return c.json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
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
        const { id } = c.req.valid("param");
        await db.delete(deliveryProviders).where(eq(deliveryProviders.id, id));
        return ok(c, {});
    } catch (error: unknown) {
        return c.json({ error: error instanceof Error ? error.message : "Failed to delete provider" }, 500);
    }
});

export { app as deliveryProvidersRoutes };
