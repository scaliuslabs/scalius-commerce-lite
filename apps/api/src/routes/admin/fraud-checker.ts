// src/server/routes/admin/fraud-checker.ts
import { Hono } from "hono";
import { FraudCheckerService } from "@scalius/core/modules/fraud-checker/service";

const app = new Hono<{ Bindings: any }>();
const fraudCheckerService = new FraudCheckerService();
const MASKED_VALUE = "••••••••••••";

app.get("/", async (c) => {
    try {
        const providers = await fraudCheckerService.getProviders();

        const maskedProviders = providers.map((provider) => ({
            ...provider,
            apiKey: provider.apiKey ? MASKED_VALUE : "",
        }));

        return c.json(maskedProviders, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.post("/", async (c) => {
    try {
        const provider = await c.req.json();

        if (!provider.name || !provider.apiUrl || !provider.apiKey) {
            return c.json({
                error: "Missing required fields",
                required: ["name", "apiUrl", "apiKey"],
            }, 400);
        }

        const savedProvider = await fraudCheckerService.saveProvider(provider);

        const maskedResponse = {
            ...savedProvider,
            apiKey: savedProvider.apiKey ? MASKED_VALUE : "",
        };

        return c.json(maskedResponse, 201);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.put("/", async (c) => {
    try {
        const provider = await c.req.json();

        if (!provider.id || !provider.name || !provider.apiUrl || !provider.apiKey) {
            return c.json({
                error: "Missing required fields",
                required: ["id", "name", "apiUrl", "apiKey"],
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
            apiKey: savedProvider.apiKey ? MASKED_VALUE : "",
        };

        return c.json(maskedResponse, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.delete("/:id", async (c) => {
    try {
        const id = c.req.param("id");

        if (!id) {
            return c.json({ error: "Provider ID is required" }, 400);
        }

        await fraudCheckerService.deleteProvider(id);
        return c.json({ success: true }, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.post("/:id/test", async (c) => {
    try {
        const id = c.req.param("id");

        if (!id) {
            return c.json({ error: "Provider ID is required" }, 400);
        }

        const result = await fraudCheckerService.testProvider(id);
        return c.json(result, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

export { app as adminFraudCheckerRoutes };
