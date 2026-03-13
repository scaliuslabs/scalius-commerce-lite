// src/server/routes/admin/fraud-checker.ts
// Admin OpenAPI routes for fraud checker providers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { FraudCheckerService } from "@scalius/core/modules/fraud-checker/service";

const app = new OpenAPIHono();
const fraudCheckerService = new FraudCheckerService();
const MASKED_VALUE = "••••••••••••";

// ── List Providers ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Fraud Checker"],
    summary: "List all fraud checker providers",
    responses: {
        200: { description: "Provider list"  }
    }
});

app.openapi(listRoute, async (c) => {
    try {
        const providers = await fraudCheckerService.getProviders();

        const maskedProviders = providers.map((provider) => ({
            ...provider,
            apiKey: provider.apiKey ? MASKED_VALUE : ""
        }));

        return c.json(maskedProviders, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Create Provider ──

const createProviderRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Fraud Checker"],
    summary: "Create a fraud checker provider",
    responses: {
        201: { description: "Provider created"  }
    }
});

app.openapi(createProviderRoute, async (c) => {
    try {
        const provider = await c.req.json();

        if (!provider.name || !provider.apiUrl || !provider.apiKey) {
            return c.json({
                error: "Missing required fields",
                required: ["name", "apiUrl", "apiKey"]
            }, 400);
        }

        const savedProvider = await fraudCheckerService.saveProvider(provider);

        const maskedResponse = {
            ...savedProvider,
            apiKey: savedProvider.apiKey ? MASKED_VALUE : ""
        };

        return c.json(maskedResponse, 201);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Update Provider ──

const updateProviderRoute = createRoute({
    method: "put",
    path: "/",
    tags: ["Admin - Fraud Checker"],
    summary: "Update a fraud checker provider",
    responses: {
        200: { description: "Provider updated"  }
    }
});

app.openapi(updateProviderRoute, async (c) => {
    try {
        const provider = await c.req.json();

        if (!provider.id || !provider.name || !provider.apiUrl || !provider.apiKey) {
            return c.json({
                error: "Missing required fields",
                required: ["id", "name", "apiUrl", "apiKey"]
            }, 400);
        }

        if (provider.apiKey === MASKED_VALUE) {
            const existingProvider = await fraudCheckerService.getProvider(provider.id);
            if (existingProvider?.apiKey) {
                provider.apiKey = existingProvider.apiKey;
            }
        }

        const savedProvider = await fraudCheckerService.saveProvider(provider);

        const maskedResponse = {
            ...savedProvider,
            apiKey: savedProvider.apiKey ? MASKED_VALUE : ""
        };

        return c.json(maskedResponse, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Delete Provider ──

const deleteProviderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Fraud Checker"],
    summary: "Delete a fraud checker provider",
    responses: {
        200: { description: "Provider deleted"  }
    }
});

app.openapi(deleteProviderRoute, async (c) => {
    try {
        const { id } = c.req.valid("param");
        await fraudCheckerService.deleteProvider(id);
        return c.json({ success: true }, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

// ── Test Provider ──

const testProviderRoute = createRoute({
    method: "post",
    path: "/{id}/test",
    tags: ["Admin - Fraud Checker"],
    summary: "Test a fraud checker provider connection",
    responses: {
        200: { description: "Test result"  }
    }
});

app.openapi(testProviderRoute, async (c) => {
    try {
        const { id } = c.req.valid("param");
        const result = await fraudCheckerService.testProvider(id);
        return c.json(result, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

export { app as adminFraudCheckerRoutes };
