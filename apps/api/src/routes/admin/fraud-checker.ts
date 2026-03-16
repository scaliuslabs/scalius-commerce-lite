// src/server/routes/admin/fraud-checker.ts
// Admin OpenAPI routes for fraud checker providers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { FraudCheckerService } from "@scalius/core/modules/fraud-checker/service";

import { ok, created } from "../../utils/api-response";
import { ValidationError } from "../../utils/api-error";
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

        return ok(c, maskedProviders);
    } catch (error: unknown) {
        throw error;
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
            throw new ValidationError("Missing required fields: name, apiUrl, apiKey");
        }

        const savedProvider = await fraudCheckerService.saveProvider(provider);

        const maskedResponse = {
            ...savedProvider,
            apiKey: savedProvider.apiKey ? MASKED_VALUE : ""
        };

        return created(c, maskedResponse);
    } catch (error: unknown) {
        throw error;
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
            throw new ValidationError("Missing required fields: id, name, apiUrl, apiKey");
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

        return ok(c, maskedResponse);
    } catch (error: unknown) {
        throw error;
    }
});

// ── Delete Provider ──

const deleteProviderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Fraud Checker"],
    summary: "Delete a fraud checker provider",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Provider deleted"  }
    }
});

app.openapi(deleteProviderRoute, async (c) => {
    try {
        const { id } = c.req.valid("param");
        await fraudCheckerService.deleteProvider(id);
        return ok(c, {});
    } catch (error: unknown) {
        throw error;
    }
});

// ── Test Provider ──

const testProviderRoute = createRoute({
    method: "post",
    path: "/{id}/test",
    tags: ["Admin - Fraud Checker"],
    summary: "Test a fraud checker provider connection",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: { description: "Test result"  }
    }
});

app.openapi(testProviderRoute, async (c) => {
    try {
        const { id } = c.req.valid("param");
        const result = await fraudCheckerService.testProvider(id);
        return ok(c, result);
    } catch (error: unknown) {
        throw error;
    }
});

export { app as adminFraudCheckerRoutes };
