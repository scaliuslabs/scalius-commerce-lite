// src/server/routes/admin/fraud-checker.ts
// Admin OpenAPI routes for fraud checker providers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getFraudProviders, getFraudProvider, saveFraudProvider, deleteFraudProvider, testFraudProvider } from "@scalius/core/modules/fraud-checker/fraud-checker.service";

import { ok, created } from "../../utils/api-response";
import { ValidationError } from "../../utils/api-error";
const app = new OpenAPIHono();
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
        const db = c.get("db");
        const providers = await getFraudProviders(db);

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

const createProviderSchema = z.object({
    name: z.string().min(1),
    apiUrl: z.string().min(1),
    apiKey: z.string().min(1),
    isActive: z.boolean().optional().default(true),
});

const createProviderRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Fraud Checker"],
    summary: "Create a fraud checker provider",
    request: {
        body: { content: { "application/json": { schema: createProviderSchema } } }
    },
    responses: {
        201: { description: "Provider created"  }
    }
});

app.openapi(createProviderRoute, async (c) => {
    try {
        const db = c.get("db");
        const provider = c.req.valid("json");

        const savedProvider = await saveFraudProvider(db, provider);

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

const updateProviderSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    apiUrl: z.string().min(1),
    apiKey: z.string().min(1),
    isActive: z.boolean().default(true),
});

const updateProviderRoute = createRoute({
    method: "put",
    path: "/",
    tags: ["Admin - Fraud Checker"],
    summary: "Update a fraud checker provider",
    request: {
        body: { content: { "application/json": { schema: updateProviderSchema } } }
    },
    responses: {
        200: { description: "Provider updated"  }
    }
});

app.openapi(updateProviderRoute, async (c) => {
    try {
        const db = c.get("db");
        const validated = c.req.valid("json");
        let apiKey = validated.apiKey;

        if (apiKey === MASKED_VALUE) {
            const existingProvider = await getFraudProvider(db, validated.id);
            if (existingProvider?.apiKey) {
                apiKey = existingProvider.apiKey;
            }
        }

        const savedProvider = await saveFraudProvider(db, { ...validated, apiKey });

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
        const db = c.get("db");
        const { id } = c.req.valid("param");
        await deleteFraudProvider(db, id);
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
        const db = c.get("db");
        const { id } = c.req.valid("param");
        const result = await testFraudProvider(db, id);
        return ok(c, result);
    } catch (error: unknown) {
        throw error;
    }
});

export { app as adminFraudCheckerRoutes };
