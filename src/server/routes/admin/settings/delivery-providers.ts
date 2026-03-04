import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { DeliveryService } from "@/modules/delivery/service";
import { createProvider } from "@/modules/delivery/factory";
import { safeErrorResponse } from "@/shared/error-utils";
import { db } from "@/db";
import { deliveryProviders } from "@/db/schema";
import { eq } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

const deliveryService = new DeliveryService();

// SECURITY: Constant for masked credentials
const MASKED_VALUE = "••••••••••••";

/**
 * SECURITY: Unmask credentials by fetching from database if fields are masked
 */
function unmaskedCredentials(
    newCredentials: string,
    existingCredentials?: string,
): string {
    try {
        const newCreds = JSON.parse(newCredentials);
        if (!existingCredentials) return newCredentials;

        const existingCreds = JSON.parse(existingCredentials);
        const unmasked = { ...newCreds };

        if (unmasked.clientSecret === MASKED_VALUE && existingCreds.clientSecret) {
            unmasked.clientSecret = existingCreds.clientSecret;
        }
        if (unmasked.password === MASKED_VALUE && existingCreds.password) {
            unmasked.password = existingCreds.password;
        }
        if (unmasked.apiKey === MASKED_VALUE && existingCreds.apiKey) {
            unmasked.apiKey = existingCreds.apiKey;
        }
        if (unmasked.secretKey === MASKED_VALUE && existingCreds.secretKey) {
            unmasked.secretKey = existingCreds.secretKey;
        }

        return JSON.stringify(unmasked);
    } catch (e) {
        return newCredentials;
    }
}

/**
 * SECURITY: Mask sensitive credentials before sending to client
 */
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

// GET /admin/settings/delivery-providers
app.get("/", async (c) => {
    try {
        const providers = await deliveryService.getProviders();
        const maskedProviders = providers.map((provider) => ({
            ...provider,
            credentials: maskCredentialsForClient(provider.credentials),
        }));

        return c.json(maskedProviders, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Failed to fetch providers" }, 500);
    }
});

// POST /admin/settings/delivery-providers
app.post("/", async (c) => {
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
        const maskedResponse = {
            ...savedProvider,
            credentials: maskCredentialsForClient(savedProvider.credentials),
        };

        return c.json(maskedResponse, 201);
    } catch (error: any) {
        return c.json({ error: error.message || "Failed to create provider" }, 500);
    }
});

// PUT /admin/settings/delivery-providers
app.put("/", async (c) => {
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
            const maskedResponse = {
                ...savedProvider,
                credentials: maskCredentialsForClient(savedProvider.credentials),
            };
            return c.json(maskedResponse, 201);
        }

        const unmaskedCreds = unmaskedCredentials(provider.credentials, existingProvider.credentials);

        const savedProvider = await deliveryService.saveProvider({
            ...provider,
            credentials: unmaskedCreds,
            id: provider.id,
            name: provider.name,
            type: provider.type,
            isActive: provider.isActive !== undefined ? provider.isActive : existingProvider.isActive,
        });

        const maskedResponse = {
            ...savedProvider,
            credentials: maskCredentialsForClient(savedProvider.credentials),
        };

        return c.json(maskedResponse, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Failed to update provider" }, 500);
    }
});

// POST /admin/settings/delivery-providers/create-test
app.post("/create-test", async (c) => {
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
            updatedAt: new Date(),
        };

        try {
            const providerInstance = createProvider(mockProvider);
            const result = await providerInstance.testConnection();

            return c.json({
                ...result,
                provider: { type, name, credentials: "...", config: "..." },
            }, 200);
        } catch (testError: any) {
            return c.json({
                success: false,
                message: testError.message || "Failed to test provider connection",
            }, 200);
        }
    } catch (error: any) {
        return c.json({ error: error.message || "Internal server error" }, 500);
    }
});

// GET /admin/settings/delivery-providers/:id
app.get("/:id", async (c) => {
    try {
        const id = c.req.param("id");
        if (!id) return c.json({ error: "Provider ID is required" }, 400);

        const provider = await deliveryService.getProvider(id);
        if (!provider) return c.json({ error: "Provider not found" }, 404);

        return c.json(provider, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Failed to get provider" }, 500);
    }
});

// POST /admin/settings/delivery-providers/:id (Test existing provider)
app.post("/:id", async (c) => {
    try {
        const id = c.req.param("id");
        if (!id) return c.json({ error: "Provider ID is required" }, 400);

        const provider = await deliveryService.getProvider(id);
        if (!provider) return c.json({ error: "Provider not found" }, 404);

        try {
            const providerInstance = createProvider(provider);
            const result = await providerInstance.testConnection();
            return c.json(result, 200);
        } catch (testError: any) {
            return c.json({
                success: false,
                message: testError.message || "Failed to test provider connection",
            }, 200);
        }
    } catch (error: any) {
        return c.json({ error: error.message || "Internal server error" }, 500);
    }
});

// DELETE /admin/settings/delivery-providers/:id
app.delete("/:id", async (c) => {
    try {
        const id = c.req.param("id");
        if (!id) return c.json({ error: "Provider ID is required" }, 400);

        await db.delete(deliveryProviders).where(eq(deliveryProviders.id, id));
        return c.json({ success: true }, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Failed to delete provider" }, 500);
    }
});

export { app as deliveryProvidersRoutes };
