// Delivery providers: a merchant's couriers. Pathao and Steadfast rows keep
// their (encrypted) credentials here; an installed app courier's row names
// it as `<plugin id>:<provider id>` and keeps none, its settings live in the
// app (GET/POST /admin/settings/providers lists and tests them). Readiness,
// activation and tests go through the courier port for every row.
import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import {
    assertDeliveryProviderActivatable,
    courierFor,
    getDeliveryProviders,
    getDeliveryProvider,
    getDeliveryProviderReadiness,
    saveDeliveryProvider,
    testDeliveryProvider,
    testDeliveryProviderSetup,
    type CourierProvidersSource,
} from "@scalius/core/modules/delivery";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { deliveryProviders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { NotFoundError, ValidationError } from "../../../utils/api-error";
import { getCredentialEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";
import { requestCourierProviders } from "../../../plugins/providers/courier";

import { ok, created } from "../../../utils/api-response";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../../schemas/responses";
import { readinessSchema } from "../../../schemas/readiness";
const app = new OpenAPIHono<{ Bindings: Env }>();

/** `pathao`, `steadfast`, or an installed app courier's `<plugin id>:<provider id>`. */
const PROVIDER_TYPE_MAX = 160;

const MASKED_VALUE = "••••••••••••";
const SENSITIVE_CREDENTIAL_KEYS = [
    "clientId",
    "clientSecret",
    "username",
    "password",
    "apiKey",
    "secretKey",
    "webhookSecret",
] as const;
const DELIVERY_PROVIDER_PAGE_LIMIT = 10;
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

function safeProviderTestResult(result: { success?: unknown }): {
    success: boolean;
    message: string;
} {
    const success = result.success === true;
    return {
        success,
        message: success ? "Connection successful" : "Connection failed",
    };
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

function projectProviderCredentials(
    type: string,
    credentials: Record<string, unknown>,
): Record<string, string> {
    const keys = type === "pathao"
        ? ["baseUrl", "clientId", "clientSecret", "username", "password", "webhookSecret"]
        : type === "steadfast"
            ? ["baseUrl", "apiKey", "secretKey", "webhookSecret"]
            : ["baseUrl"];
    return Object.fromEntries(keys.flatMap((key) => {
        const value = credentials[key];
        if (typeof value !== "string") return [];
        return [[key, key === "baseUrl" ? value.slice(0, 2048) : value ? MASKED_VALUE : ""]];
    }));
}

function projectProviderConfig(type: string, configJson: string): string {
    try {
        const config = parseJsonObject(configJson);
        if (type === "pathao") {
            return JSON.stringify({
                storeId: typeof config.storeId === "string" ? config.storeId.slice(0, 100) : "",
                defaultDeliveryType: Number.isFinite(Number(config.defaultDeliveryType)) ? Number(config.defaultDeliveryType) : 48,
                defaultItemType: Number.isFinite(Number(config.defaultItemType)) ? Number(config.defaultItemType) : 2,
                defaultItemWeight: Number.isFinite(Number(config.defaultItemWeight)) ? Number(config.defaultItemWeight) : 0.5,
            });
        }
        if (type === "steadfast") {
            return JSON.stringify({
                defaultCodAmount: Number.isFinite(Number(config.defaultCodAmount)) ? Number(config.defaultCodAmount) : 0,
            });
        }
        return "{}";
    } catch {
        return "{}";
    }
}

async function maskCredentialsForClient(
    type: string,
    credentialsJson: string,
    env: Record<string, unknown>,
): Promise<string> {
    try {
        const credentials = parseJsonObject(await decryptStoredCredentials(credentialsJson, env));
        return JSON.stringify(projectProviderCredentials(type, credentials));
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
    couriers: CourierProvidersSource,
) {
    // Unreadable credentials mask to nothing; the courier judges readiness.
    const [maskedCredentials, readiness, courier] = await Promise.all([
        maskCredentialsForClient(provider.type, provider.credentials, env).catch(() => "{}"),
        getDeliveryProviderReadiness(provider, getCredentialEncryptionKey(env), couriers),
        courierFor(couriers, provider.type),
    ]);

    return {
        id: provider.id.slice(0, 100),
        name: provider.name.slice(0, 100),
        type: provider.type.slice(0, PROVIDER_TYPE_MAX),
        isActive: provider.isActive,
        // The countries it delivers to: the order page offers it only for an order shipping there.
        countries: courier?.countries ?? "any",
        credentials: maskedCredentials,
        config: projectProviderConfig(provider.type, provider.config),
        createdAt: requiredTimestampForClient(provider.createdAt),
        updatedAt: requiredTimestampForClient(provider.updatedAt),
        readiness: {
            status: readiness.status,
            lifecycle: readiness.lifecycle,
            configured: readiness.configured,
            tested: readiness.tested,
            active: readiness.active,
            canCreateShipment: readiness.active,
            issues: readiness.issues.slice(0, 20).map((issue) => ({
                code: issue.code.slice(0, 100),
                message: issue.message.slice(0, 500),
            })),
            activationBlockers: readiness.activationBlockers.slice(0, 20).map((blocker) => ({
                source: blocker.source.slice(0, 100),
                key: blocker.key.slice(0, 100),
                label: blocker.label.slice(0, 100),
                message: blocker.message.slice(0, 500),
            })),
            lastTestAttemptAt: timestampForClient(readiness.lastTestAttemptAt),
            lastTestSuccessAt: timestampForClient(readiness.lastTestSuccessAt),
            lastTestFailureAt: timestampForClient(readiness.lastTestFailureAt),
        },
    };
}

// ── List Providers ──

const deliveryProviderSchema = z.object({
    id: z.string().max(100),
    name: z.string().max(100),
    /** `pathao`, `steadfast`, or an app courier's `<plugin id>:<provider id>`. */
    type: z.string().max(PROVIDER_TYPE_MAX),
    credentials: z.string().max(4096),
    config: z.string().max(4096),
    isActive: z.boolean(),
    /** `any`, or the ISO countries it delivers to (MARKETS-DESIGN step 3a): offered only for an order shipping there. */
    countries: z.union([z.literal("any"), z.array(z.string().length(2)).max(250)]),
    readiness: readinessSchema.extend({
        /** Setup lifecycle position; the readiness verdict is `status`. */
        lifecycle: z.enum(["draft", "configured", "tested", "active", "blocked"]),
        configured: z.boolean(),
        tested: z.boolean(),
        active: z.boolean(),
        canCreateShipment: z.boolean(),
        activationBlockers: z.array(z.object({
            source: z.string(),
            key: z.string(),
            label: z.string(),
            message: z.string(),
        })),
        lastTestAttemptAt: z.union([z.string(), z.number()]).nullable().optional(),
        lastTestSuccessAt: z.union([z.string(), z.number()]).nullable().optional(),
        lastTestFailureAt: z.union([z.string(), z.number()]).nullable().optional(),
    }).optional(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
});

const listRoute = createRoute({
    method: "get",
    path: "/",
    operationId: "dashboard.delivery_providers.list",
    tags: ["Admin - Delivery Providers"],
    summary: "List all delivery providers",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(DELIVERY_PROVIDER_PAGE_LIMIT).default(DELIVERY_PROVIDER_PAGE_LIMIT),
        }),
    },
    responses: {
        200: { description: "Provider list", content: { "application/json": { schema: successEnvelope(z.object({
            providers: z.array(deliveryProviderSchema).max(DELIVERY_PROVIDER_PAGE_LIMIT),
            pagination: z.object({
                page: z.number().int().min(1),
                limit: z.number().int().min(1).max(DELIVERY_PROVIDER_PAGE_LIMIT),
                hasMore: z.boolean(),
            }),
        })) } } },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const { page, limit } = c.req.valid("query");
    const providerRows = await getDeliveryProviders(db, { limit: limit + 1, offset: (page - 1) * limit });
    const providers = providerRows.slice(0, limit);
    const env = c.env as Record<string, unknown>;
    const couriers = requestCourierProviders(c);
    const maskedProviders = await Promise.all(providers.map((provider) => serializeProviderForClient(provider, env, couriers)));

    return ok(c, {
        providers: maskedProviders,
        pagination: { page, limit, hasMore: providerRows.length > limit },
    });
});

// ── Create Provider ──

const encodedProviderObjectSchema = z.string().max(32_768).describe(
    "Legacy JSON-encoded object accepted for dashboard compatibility; CLI and MCP callers should send the typed object variant.",
);
const pathaoCredentialsSchema = z.object({
    baseUrl: z.string().max(2_048).optional().describe("Optional Pathao API origin; defaults to https://api-hermes.pathao.com."),
    clientId: z.string().max(512).optional().describe("Pathao client ID; required before activation."),
    clientSecret: z.string().max(2_048).optional().describe("Pathao client secret; required before activation."),
    username: z.string().max(320).optional().describe("Pathao account username; required before activation."),
    password: z.string().max(2_048).optional().describe("Pathao account password; required before activation."),
    webhookSecret: z.string().max(512).optional().describe("Optional shared secret used to verify Pathao webhooks."),
}).strict();
const pathaoConfigSchema = z.object({
    storeId: z.string().max(100).optional().describe("Pathao store ID; required before activation."),
    defaultDeliveryType: z.union([z.literal(48), z.literal(12)]).optional().describe("48 for normal delivery or 12 for on-demand delivery; defaults to 48."),
    defaultItemType: z.union([z.literal(2), z.literal(1)]).optional().describe("2 for parcel or 1 for document; defaults to 2."),
    defaultItemWeight: z.number().min(0.1).max(50).optional().describe("Default parcel weight in kilograms; defaults to 0.5."),
}).strict();
const steadfastCredentialsSchema = z.object({
    baseUrl: z.string().max(2_048).optional().describe("Optional Steadfast API origin; defaults to https://portal.packzy.com/api/v1."),
    apiKey: z.string().max(2_048).optional().describe("Steadfast API key; required before activation."),
    secretKey: z.string().max(2_048).optional().describe("Steadfast secret key; required before activation."),
    webhookSecret: z.string().max(512).optional().describe("Optional shared secret used to verify Steadfast webhooks."),
}).strict();
const steadfastConfigSchema = z.object({
    defaultCodAmount: z.number().min(0).max(1_000_000_000).optional().describe("Default cash-on-delivery amount; defaults to 0."),
}).strict();

const providerObjectInput = <T extends z.ZodTypeAny>(schema: T) =>
    z.union([encodedProviderObjectSchema, schema]);

/** An installed app courier: its credentials and options live in the app's settings, never on the row. */
const appCourierTypeSchema = z.string().max(PROVIDER_TYPE_MAX)
    .refine(isQualifiedProviderId, "Name an app courier as <plugin id>:<provider id>.")
    .describe("An installed app courier, <plugin id>:<provider id> (GET /admin/settings/providers?kind=courier lists them). Set it up in the app's settings.");

const createDeliveryProviderSchema = z.union([
    z.object({
        name: z.string().min(1).max(100),
        type: z.literal("pathao"),
        credentials: providerObjectInput(pathaoCredentialsSchema),
        config: providerObjectInput(pathaoConfigSchema),
        isActive: z.boolean().optional().default(false),
    }),
    z.object({
        name: z.string().min(1).max(100),
        type: z.literal("steadfast"),
        credentials: providerObjectInput(steadfastCredentialsSchema),
        config: providerObjectInput(steadfastConfigSchema),
        isActive: z.boolean().optional().default(false),
    }),
    z.object({
        name: z.string().min(1).max(100),
        type: appCourierTypeSchema,
        isActive: z.boolean().optional().default(false),
    }).strict(),
]);

/** The row-held setup of a request body: an app courier's row holds none. */
function bodySetup(body: { credentials?: string | Record<string, unknown>; config?: string | Record<string, unknown> } | object) {
    return {
        credentials: "credentials" in body ? stringifyJsonInput(body.credentials as string | Record<string, unknown> | undefined) : undefined,
        config: "config" in body ? stringifyJsonInput(body.config as string | Record<string, unknown> | undefined) : undefined,
    };
}

const createProviderRoute = createRoute({
    method: "post",
    path: "/",
    operationId: "dashboard.delivery_providers.create",
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
    const couriers = requestCourierProviders(c);
    const setup = bodySetup(validated);
    const credentials = setup.credentials ?? "{}";
    const config = setup.config ?? "{}";

    if (validated.isActive) {
        await assertDeliveryProviderActivatable({ type: validated.type, credentials, config }, encryptionKey, couriers);
    }

    const provider = {
        id: "",
        name: validated.name,
        type: validated.type,
        isActive: validated.isActive,
        credentials,
        config,
    };

    const savedProvider = await saveDeliveryProvider(db, provider, encryptionKey, couriers);
    const reloadedProvider = await getDeliveryProvider(db, savedProvider.id);
    if (!reloadedProvider) throw new NotFoundError("Provider not found after save");
    const maskedResponse = await serializeProviderForClient(reloadedProvider, env, couriers);

    return created(c, maskedResponse);
}) as unknown as AppRouteHandler<typeof createProviderRoute>);

// ── Update Provider ──

const updateDeliveryProviderSchema = z.union([
    z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        type: z.literal("pathao"),
        credentials: providerObjectInput(pathaoCredentialsSchema).optional(),
        config: providerObjectInput(pathaoConfigSchema).optional(),
        isActive: z.boolean().optional(),
    }),
    z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        type: z.literal("steadfast"),
        credentials: providerObjectInput(steadfastCredentialsSchema).optional(),
        config: providerObjectInput(steadfastConfigSchema).optional(),
        isActive: z.boolean().optional(),
    }),
    z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        type: appCourierTypeSchema,
        isActive: z.boolean().optional(),
    }).strict(),
]);

const updateProviderRoute = createRoute({
    method: "put",
    path: "/",
    operationId: "dashboard.delivery_providers.update",
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
    const couriers = requestCourierProviders(c);
    const { credentials, config } = bodySetup(validated);

    const existingProvider = await getDeliveryProvider(db, validated.id);
    if (!existingProvider) {
        const isActive = validated.isActive ?? false;
        const providerCredentials = credentials || "{}";
        const providerConfig = config || "{}";
        if (isActive) {
            await assertDeliveryProviderActivatable({
                type: validated.type,
                credentials: providerCredentials,
                config: providerConfig,
            }, encryptionKey, couriers);
        }

        const savedProvider = await saveDeliveryProvider(db, {
            id: validated.id,
            name: validated.name,
            type: validated.type,
            isActive,
            credentials: providerCredentials,
            config: providerConfig,
        }, encryptionKey, couriers);
        const reloadedProvider = await getDeliveryProvider(db, savedProvider.id);
        if (!reloadedProvider) throw new NotFoundError("Provider not found after save");
        const maskedResponse = await serializeProviderForClient(reloadedProvider, env, couriers);

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
        await assertDeliveryProviderActivatable({
            type: validated.type,
            credentials: unmaskedCreds,
            config: nextConfig,
        }, encryptionKey, couriers);
    }

    const savedProvider = await saveDeliveryProvider(db, {
        id: validated.id,
        name: validated.name,
        type: validated.type,
        isActive: nextIsActive,
        credentials: unmaskedCreds,
        config: nextConfig,
    }, encryptionKey, couriers);

    const reloadedProvider = await getDeliveryProvider(db, savedProvider.id);
    if (!reloadedProvider) throw new NotFoundError("Provider not found after save");
    const maskedResponse = await serializeProviderForClient(reloadedProvider, env, couriers);

    return ok(c, maskedResponse);
}) as unknown as AppRouteHandler<typeof updateProviderRoute>);

// ── Create Test Provider ──

const createTestSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("pathao"),
        credentials: providerObjectInput(pathaoCredentialsSchema),
        config: providerObjectInput(pathaoConfigSchema),
        name: z.string().max(100).optional().default("Test Provider"),
    }),
    z.object({
        type: z.literal("steadfast"),
        credentials: providerObjectInput(steadfastCredentialsSchema),
        config: providerObjectInput(steadfastConfigSchema),
        name: z.string().max(100).optional().default("Test Provider"),
    }),
]);

const testResultSchema = z.object({
    success: z.boolean(),
    message: z.string(),
});

const createTestRoute = createRoute({
    method: "post",
    path: "/create-test",
    operationId: "dashboard.delivery_providers.test_credentials",
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
    const { type, credentials, config } = c.req.valid("json");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const couriers = requestCourierProviders(c);
    const draft = {
        id: "test_" + Date.now().toString(),
        type,
        isActive: true,
        credentials: typeof credentials === "string" ? credentials : JSON.stringify(credentials),
        config: typeof config === "string" ? config : JSON.stringify(config),
        lastTestAttemptAt: null,
        lastTestSuccessAt: null,
        lastTestFailureAt: null,
        lastTestSuccessFingerprint: null,
    };

    await assertDeliveryProviderActivatable(draft, encryptionKey, couriers);

    try {
        return ok(c, safeProviderTestResult(await testDeliveryProviderSetup(c.get("db"), draft, encryptionKey, couriers)));
    } catch {
        return ok(c, safeProviderTestResult({ success: false }));
    }
});

// ── Get Provider ──

const getProviderRoute = createRoute({
    method: "get",
    path: "/{id}",
    operationId: "dashboard.delivery_providers.get",
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
    return ok(c, await serializeProviderForClient(provider, c.env as Record<string, unknown>, requestCourierProviders(c)));
});

// ── Test Existing Provider ──

const testExistingRoute = createRoute({
    method: "post",
    path: "/{id}",
    operationId: "dashboard.delivery_providers.test",
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
    const result = await testDeliveryProvider(db, id, getCredentialEncryptionKey(c.env as Record<string, unknown>), requestCourierProviders(c));

    return ok(c, safeProviderTestResult(result));
});

// ── Delete Provider ──

const deleteProviderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.delivery_providers.delete",
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
