// Delivery providers: a merchant's couriers. Every courier is an app's: a
// row names it as `<plugin id>:<provider id>` and keeps no keys, its
// settings live in the app (GET/POST /admin/settings/providers lists and
// tests them). Readiness, activation and tests go through the courier port.
import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import {
    courierFor,
    getDeliveryProviders,
    getDeliveryProvider,
    getDeliveryProviderReadiness,
    saveDeliveryProvider,
    testDeliveryProvider,
    type CourierProvidersSource,
} from "@scalius/core/modules/delivery";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { deliveryProviders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../../utils/api-error";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { requestCourierProviders } from "../../../plugins/providers/courier";

import { ok, created } from "../../../utils/api-response";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../../schemas/responses";
import { readinessSchema } from "../../../schemas/readiness";
const app = new OpenAPIHono<{ Bindings: Env }>();

const PROVIDER_TYPE_MAX = 160;
const DELIVERY_PROVIDER_PAGE_LIMIT = 10;
type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AppRouteContext<R extends RouteConfig> = Parameters<AppRouteHandler<R>>[0];

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
    const [readiness, courier] = await Promise.all([
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
        /** The courier's name (`Pathao`), whether or not its app is active. */
        courierName: (courier?.label ?? provider.type).slice(0, 100),
        /** The address levels a booking needs mapped to the courier's own place ids (the order page asks first). */
        requiredLocations: [...(courier?.requiredLocations ?? [])],
        /** Whether the courier can find a booking by the order number (recovering a lost answer). */
        canFindShipment: Boolean(courier?.findShipment),
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
    /** An app courier's `<plugin id>:<provider id>`. */
    type: z.string().max(PROVIDER_TYPE_MAX),
    courierName: z.string().max(100),
    requiredLocations: z.array(z.enum(["city", "zone", "area"])).max(3),
    canFindShipment: z.boolean(),
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

/** An installed app courier: its credentials and options live in the app's settings, never on the row. */
const appCourierTypeSchema = z.string().max(PROVIDER_TYPE_MAX)
    .refine(isQualifiedProviderId, "Name an app courier as <plugin id>:<provider id>.")
    .describe("An installed app courier, <plugin id>:<provider id> (GET /admin/settings/providers?kind=courier lists them). Set it up in the app's settings.");

const createDeliveryProviderSchema = z.object({
    name: z.string().min(1).max(100),
    type: appCourierTypeSchema,
    isActive: z.boolean().optional().default(false),
}).strict();

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
    const couriers = requestCourierProviders(c);
    const savedProvider = await saveDeliveryProvider(db, {
        id: "",
        name: validated.name,
        type: validated.type,
        isActive: validated.isActive,
    }, getCredentialEncryptionKey(env), couriers);
    const reloadedProvider = await getDeliveryProvider(db, savedProvider.id);
    if (!reloadedProvider) throw new NotFoundError("Provider not found after save");
    return created(c, await serializeProviderForClient(reloadedProvider, env, couriers));
}) as unknown as AppRouteHandler<typeof createProviderRoute>);

// ── Update Provider ──

const updateDeliveryProviderSchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    type: appCourierTypeSchema,
    isActive: z.boolean().optional(),
}).strict();

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
    const couriers = requestCourierProviders(c);
    const existingProvider = await getDeliveryProvider(db, validated.id);
    const savedProvider = await saveDeliveryProvider(db, {
        id: validated.id,
        name: validated.name,
        type: validated.type,
        isActive: validated.isActive ?? existingProvider?.isActive ?? false,
    }, getCredentialEncryptionKey(env), couriers);
    const reloadedProvider = await getDeliveryProvider(db, savedProvider.id);
    if (!reloadedProvider) throw new NotFoundError("Provider not found after save");
    const body = await serializeProviderForClient(reloadedProvider, env, couriers);
    return existingProvider ? ok(c, body) : created(c, body);
}) as unknown as AppRouteHandler<typeof updateProviderRoute>);

const testResultSchema = z.object({
    success: z.boolean(),
    message: z.string(),
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
