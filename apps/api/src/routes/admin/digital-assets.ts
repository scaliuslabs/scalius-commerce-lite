// Dashboard digital-goods routes (admin catalog family, Wave B design §3.5,
// §7.2): a product's files and licence-key pools (mounted at /admin/products),
// multipart uploads and key pools (/admin/digital-assets), and what an order
// line received (/admin/digital-entitlements: allow more downloads, revoke).
// Permissions: packages/core/src/auth/rbac/route-permissions/digital.ts.
//
// Staff never see a plaintext licence key after import: pools list keys by
// their last 4 characters only.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    completeDigitalAssetUpload,
    createDigitalAsset,
    deleteDigitalAsset,
    getDigitalAssetUpload,
    importLicenceKeys,
    listLicenceKeys,
    listProductDigitalAssets,
    resetDigitalEntitlement,
    revokeDigitalEntitlement,
    revokeLicenceKeys,
    startDigitalAssetUpload,
    updateDigitalAsset,
    uploadDigitalAssetPart,
} from "@scalius/core/modules/digital";
import {
    DIGITAL_DOWNLOAD_LIMIT_MAX,
    DIGITAL_ACCESS_DAYS_MAX,
    DIGITAL_MAX_FILE_BYTES,
    DIGITAL_MAX_UPLOAD_PARTS,
    DIGITAL_UPLOAD_PART_BYTES,
    LICENCE_KEY_IMPORT_MAX_KEYS,
    LICENCE_KEY_MAX_LENGTH,
    LICENCE_KEY_STATUSES,
} from "@scalius/shared/digital";
import { ok, created } from "../../utils/api-response";
import { ValidationError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { bumpCacheGeneration } from "../../utils/cache-generation";
import { findStockMutationAvailabilityTransitions } from "../../utils/availability-transitions";
import {
    conflictResponse,
    errorResponses,
    serviceUnavailableResponse,
    successEnvelope,
} from "../../schemas/responses";

export const adminDigitalAssetRoutes = new OpenAPIHono<{ Bindings: Env }>();
export const adminProductDigitalAssetRoutes = new OpenAPIHono<{ Bindings: Env }>();
export const adminDigitalEntitlementRoutes = new OpenAPIHono<{ Bindings: Env }>();

const TAG = "Admin - Digital goods";

function actorIdOf(c: { get(key: "user"): unknown }): string | undefined {
    return (c.get("user") as { id?: string } | undefined)?.id ?? undefined;
}

const requestKeySchema = z.string().uuid().openapi({
    description: "Retry key: repeating the request returns the first result instead of acting twice.",
});

const idParam = z.object({ id: z.string().min(1).max(80) });
const uploadParam = z.object({ id: z.string().min(1).max(80), uploadId: z.string().min(1).max(80) });

const downloadLimitSchema = z.number().int().min(1).max(DIGITAL_DOWNLOAD_LIMIT_MAX).nullable().openapi({
    description: "Downloads per purchase (1–100), or null for unlimited. Default 5.",
});
const accessDaysSchema = z.number().int().min(1).max(DIGITAL_ACCESS_DAYS_MAX).nullable().openapi({
    description: "Days of access after delivery (1–3650), or null for forever (the default).",
});

const digitalAssetSchema = z.object({
    id: z.string(),
    productId: z.string(),
    variantId: z.string().nullable().openapi({ description: "Null: every digital variant of the product receives this file." }),
    kind: z.enum(["file", "licence_keys"]),
    status: z.enum(["draft", "ready", "archived"]).openapi({ description: "`draft` until the file is uploaded; `archived` items are not delivered to new orders." }),
    displayName: z.string(),
    filename: z.string().nullable(),
    mediaType: z.string().nullable(),
    sizeBytes: z.number().int().nullable(),
    hasFile: z.boolean(),
    downloadLimit: z.number().int().nullable(),
    accessDays: z.number().int().nullable(),
    version: z.number().int(),
    keys: z.object({
        available: z.number().int(),
        assigned: z.number().int(),
        revoked: z.number().int(),
    }).openapi({ description: "Licence-key pools: keys by status (available = the variant's unsold keys)." }),
    deliveredCount: z.number().int(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
}).openapi("DigitalAsset");

const uploadSessionSchema = z.object({
    id: z.string(),
    assetId: z.string(),
    partSize: z.number().int().openapi({ description: "Every part but the last is exactly this many bytes (50 MiB)." }),
    partCount: z.number().int(),
    sizeBytes: z.number().int(),
    uploadedParts: z.array(z.number().int()),
}).openapi("DigitalUploadSession");

const fileInputSchema = z.object({
    filename: z.string().trim().min(1).max(255),
    mediaType: z.string().trim().max(200).default("application/octet-stream"),
    sizeBytes: z.number().int().min(1).max(DIGITAL_MAX_FILE_BYTES).openapi({
        description: `Exact file size; at most ${DIGITAL_MAX_UPLOAD_PARTS} parts of ${DIGITAL_UPLOAD_PART_BYTES} bytes.`,
    }),
});

const createAssetBodySchema = z.discriminatedUnion("kind", [
    fileInputSchema.extend({
        kind: z.literal("file"),
        variantId: z.string().min(1).max(80).nullable().optional(),
        displayName: z.string().trim().max(200).optional(),
        downloadLimit: downloadLimitSchema.optional(),
        accessDays: accessDaysSchema.optional(),
    }).strict(),
    z.object({
        kind: z.literal("licence_keys"),
        variantId: z.string().min(1).max(80),
        displayName: z.string().trim().max(200).optional(),
    }).strict(),
]);

const assetErrorResponses = {
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
};

// ─── Product assets ──────────────────────────────────────────────────────

adminProductDigitalAssetRoutes.openapi(createRoute({
    method: "get",
    path: "/{id}/digital-assets",
    operationId: "dashboard.digital_assets.list",
    tags: [TAG],
    summary: "List a product's downloadable files and licence-key pools",
    request: { params: idParam },
    responses: {
        200: { description: "Digital items", content: { "application/json": { schema: successEnvelope(z.object({ assets: z.array(digitalAssetSchema) })) } } },
        ...errorResponses,
    },
}), async (c) => ok(c, { assets: await listProductDigitalAssets(c.get("db"), c.req.valid("param").id) }));

adminProductDigitalAssetRoutes.openapi(createRoute({
    method: "post",
    path: "/{id}/digital-assets",
    operationId: "dashboard.digital_assets.create",
    tags: [TAG],
    summary: "Add a downloadable file (starts its upload) or a licence-key pool to a product",
    description: "A file starts as `draft` with an upload session: send each part with dashboard.digital_assets.upload_part, then dashboard.digital_assets.upload_complete. A key pool belongs to one digital variant whose quantity is tracked: imported keys become its stock.",
    request: {
        params: idParam,
        body: { required: true, content: { "application/json": { schema: createAssetBodySchema } } },
    },
    responses: {
        201: {
            description: "Digital item added",
            content: { "application/json": { schema: successEnvelope(z.object({ asset: digitalAssetSchema, upload: uploadSessionSchema.nullable() })) } },
        },
        ...assetErrorResponses,
    },
}), async (c) => {
    const result = await createDigitalAsset(c.get("db"), c.env.BUCKET, c.req.valid("param").id, c.req.valid("json"));
    return created(c, result);
});

// ─── One asset ───────────────────────────────────────────────────────────

adminDigitalAssetRoutes.openapi(createRoute({
    method: "patch",
    path: "/{id}",
    operationId: "dashboard.digital_assets.update",
    tags: [TAG],
    summary: "Rename a digital item, change its limits, or archive or restore it",
    description: "Limits apply to new deliveries; lines already delivered keep what they got.",
    request: {
        params: idParam,
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        version: z.number().int().min(1),
                        displayName: z.string().trim().max(200).optional(),
                        downloadLimit: downloadLimitSchema.optional(),
                        accessDays: accessDaysSchema.optional(),
                        status: z.enum(["ready", "archived"]).optional(),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: { description: "Digital item saved", content: { "application/json": { schema: successEnvelope(z.object({ asset: digitalAssetSchema })) } } },
        ...assetErrorResponses,
    },
}), async (c) => ok(c, { asset: await updateDigitalAsset(c.get("db"), c.req.valid("param").id, c.req.valid("json")) }));

adminDigitalAssetRoutes.openapi(createRoute({
    method: "delete",
    path: "/{id}",
    operationId: "dashboard.digital_assets.delete",
    tags: [TAG],
    summary: "Delete a digital item nobody received",
    description: "Delivered files and pools holding keys are records: archive them instead.",
    request: { params: idParam },
    responses: {
        200: { description: "Deleted", content: { "application/json": { schema: successEnvelope(z.object({ deleted: z.literal(true) })) } } },
        ...assetErrorResponses,
    },
}), async (c) => ok(c, await deleteDigitalAsset(c.get("db"), c.env.BUCKET, c.req.valid("param").id)));

// ─── Uploads ─────────────────────────────────────────────────────────────

adminDigitalAssetRoutes.openapi(createRoute({
    method: "post",
    path: "/{id}/uploads",
    operationId: "dashboard.digital_assets.upload_start",
    tags: [TAG],
    summary: "Replace a digital file: start a new upload",
    description: "The current file keeps downloading until the new upload completes; then everyone who bought it gets the new file.",
    request: {
        params: idParam,
        body: { required: true, content: { "application/json": { schema: fileInputSchema.strict() } } },
    },
    responses: {
        201: { description: "Upload started", content: { "application/json": { schema: successEnvelope(z.object({ upload: uploadSessionSchema })) } } },
        ...assetErrorResponses,
    },
}), async (c) => created(c, {
    upload: await startDigitalAssetUpload(c.get("db"), c.env.BUCKET, c.req.valid("param").id, c.req.valid("json")),
}));

adminDigitalAssetRoutes.openapi(createRoute({
    method: "get",
    path: "/{id}/uploads/{uploadId}",
    operationId: "dashboard.digital_assets.upload_get",
    tags: [TAG],
    summary: "Read an upload session (to resume it)",
    request: { params: uploadParam },
    responses: {
        200: {
            description: "Upload session",
            content: { "application/json": { schema: successEnvelope(z.object({ upload: uploadSessionSchema.extend({ status: z.string() }) })) } },
        },
        ...errorResponses,
    },
}), async (c) => {
    const { id, uploadId } = c.req.valid("param");
    return ok(c, { upload: await getDigitalAssetUpload(c.get("db"), id, uploadId) });
});

adminDigitalAssetRoutes.openapi(createRoute({
    method: "put",
    path: "/{id}/uploads/{uploadId}/parts/{partNumber}",
    operationId: "dashboard.digital_assets.upload_part",
    tags: [TAG],
    summary: "Send one 50 MiB part of a digital file",
    description: "Raw application/octet-stream with an exact Content-Length. Every part but the last is exactly session.partSize bytes; re-sending a part replaces it.",
    request: {
        params: uploadParam.extend({ partNumber: z.coerce.number().int().min(1).max(DIGITAL_MAX_UPLOAD_PARTS) }),
        body: {
            required: true,
            content: {
                "application/octet-stream": {
                    schema: z.string().min(1).max(DIGITAL_UPLOAD_PART_BYTES).openapi({ format: "binary" }),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Part stored",
            content: { "application/json": { schema: successEnvelope(z.object({ partNumber: z.number().int(), size: z.number().int() })) } },
        },
        ...assetErrorResponses,
    },
}), async (c) => {
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
        throw new ValidationError("File parts require application/octet-stream.");
    }
    const size = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(size) || size < 1 || size > DIGITAL_UPLOAD_PART_BYTES) {
        throw new ValidationError("File parts require an exact Content-Length header.");
    }
    const body = c.req.raw.body;
    if (!body) throw new ValidationError("The part is empty.");
    const { id, uploadId, partNumber } = c.req.valid("param");
    // R2 needs a stream of known length: pass the body through a fixed-length stream.
    const FixedLength = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
    let stream: ReadableStream | ArrayBuffer;
    if (FixedLength) {
        const fixed = new FixedLength(size);
        void body.pipeTo(fixed.writable).catch(() => undefined);
        stream = fixed.readable;
    } else {
        stream = await new Response(body).arrayBuffer();
        if (stream.byteLength !== size) throw new ValidationError("The part doesn't match its Content-Length.");
    }
    return ok(c, await uploadDigitalAssetPart(c.get("db"), c.env.BUCKET, { assetId: id, uploadId, partNumber, size, body: stream }));
});

adminDigitalAssetRoutes.openapi(createRoute({
    method: "post",
    path: "/{id}/uploads/{uploadId}/complete",
    operationId: "dashboard.digital_assets.upload_complete",
    tags: [TAG],
    summary: "Finish a digital file upload",
    description: "Assembles the parts; the item becomes `ready` (delivered to new orders) and buyers who already own it get this file. Safe to repeat.",
    request: { params: uploadParam },
    responses: {
        200: { description: "Upload complete", content: { "application/json": { schema: successEnvelope(z.object({ asset: digitalAssetSchema })) } } },
        ...assetErrorResponses,
    },
}), async (c) => {
    const { id, uploadId } = c.req.valid("param");
    return ok(c, { asset: await completeDigitalAssetUpload(c.get("db"), c.env.BUCKET, { assetId: id, uploadId }) });
});

// ─── Licence keys ────────────────────────────────────────────────────────

const licenceKeyAdminSchema = z.object({
    id: z.string(),
    last4: z.string().openapi({ description: "The key's last characters; the full key is never shown to staff after import." }),
    status: z.enum(LICENCE_KEY_STATUSES),
    orderItemId: z.string().nullable(),
    assignedAt: z.number().int().nullable(),
    revokedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
}).openapi("LicenceKeyAdmin");

adminDigitalAssetRoutes.openapi(createRoute({
    method: "get",
    path: "/{id}/licence-keys",
    operationId: "dashboard.digital_assets.licence_keys_list",
    tags: [TAG],
    summary: "List a pool's licence keys (masked), oldest first",
    request: {
        params: idParam,
        query: z.object({
            status: z.enum(LICENCE_KEY_STATUSES).optional(),
            cursor: z.string().max(120).optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
    },
    responses: {
        200: {
            description: "Licence keys",
            content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(licenceKeyAdminSchema), nextCursor: z.string().nullable() })) } },
        },
        ...errorResponses,
    },
}), async (c) => {
    const query = c.req.valid("query");
    return ok(c, await listLicenceKeys(c.get("db"), { assetId: c.req.valid("param").id, ...query }));
});

async function bumpIfBandChanged(c: Parameters<typeof bumpCacheGeneration>[0] & { get(key: "db"): Parameters<typeof findStockMutationAvailabilityTransitions>[0] }, result: { variantId: string; previousStock: number; stock: number }) {
    if (result.previousStock === result.stock) return;
    const changed = await findStockMutationAvailabilityTransitions(c.get("db"), [{ variantId: result.variantId, previousStock: result.previousStock, newStock: result.stock, pool: "stock" }]);
    if (changed.length > 0) await bumpCacheGeneration(c);
}

adminDigitalAssetRoutes.openapi(createRoute({
    method: "post",
    path: "/{id}/licence-keys",
    operationId: "dashboard.digital_assets.licence_keys_import",
    tags: [TAG],
    summary: "Import licence keys into a pool (they become the variant's stock)",
    description: `One key per entry, at most ${LICENCE_KEY_IMPORT_MAX_KEYS} per request and ${LICENCE_KEY_MAX_LENGTH} characters each. Keys already in the pool are skipped. The keys and the stock increase commit together.`,
    request: {
        params: idParam,
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        requestKey: requestKeySchema,
                        keys: z.array(z.string().max(LICENCE_KEY_MAX_LENGTH * 4)).min(1).max(LICENCE_KEY_IMPORT_MAX_KEYS),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Keys imported",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        imported: z.number().int(),
                        alreadyInPool: z.number().int(),
                        rejected: z.array(z.object({ line: z.number().int(), reason: z.enum(["too_long", "invalid_characters", "duplicate"]) })),
                        replayed: z.boolean(),
                        stock: z.number().int(),
                    })),
                },
            },
        },
        ...assetErrorResponses,
    },
}), async (c) => {
    const body = c.req.valid("json");
    const result = await importLicenceKeys(c.get("db"), {
        assetId: c.req.valid("param").id,
        keys: body.keys,
        requestKey: body.requestKey,
        credentialKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
        adminUserId: actorIdOf(c),
    });
    await bumpIfBandChanged(c, result);
    return ok(c, {
        imported: result.imported,
        alreadyInPool: result.alreadyInPool,
        rejected: result.rejected,
        replayed: result.replayed,
        stock: result.stock,
    });
});

adminDigitalAssetRoutes.openapi(createRoute({
    method: "post",
    path: "/{id}/licence-keys/revoke",
    operationId: "dashboard.digital_assets.licence_keys_revoke",
    tags: [TAG],
    summary: "Remove unused licence keys from a pool (and from the variant's stock)",
    description: "Only unused keys; keys held by checkouts in progress can't be removed.",
    request: {
        params: idParam,
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        requestKey: requestKeySchema,
                        keyIds: z.array(z.string().min(1).max(80)).min(1).max(90),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Keys removed",
            content: { "application/json": { schema: successEnvelope(z.object({ revoked: z.number().int(), stock: z.number().int(), replayed: z.boolean() })) } },
        },
        ...assetErrorResponses,
    },
}), async (c) => {
    const body = c.req.valid("json");
    const result = await revokeLicenceKeys(c.get("db"), {
        assetId: c.req.valid("param").id,
        keyIds: body.keyIds,
        requestKey: body.requestKey,
        adminUserId: actorIdOf(c),
    });
    await bumpIfBandChanged(c, result);
    return ok(c, { revoked: result.revoked, stock: result.stock, replayed: result.replayed });
});

// ─── Entitlements (what an order line received) ─────────────────────────

const entitlementActionResponse = {
    200: {
        description: "Saved",
        content: { "application/json": { schema: successEnvelope(z.object({ entitlementId: z.string(), orderId: z.string() })) } },
    },
    ...errorResponses,
};

adminDigitalEntitlementRoutes.openapi(createRoute({
    method: "post",
    path: "/{id}/reset",
    operationId: "dashboard.digital_entitlements.reset",
    tags: [TAG],
    summary: "Allow more downloads: reset a delivered file's download count",
    request: { params: idParam },
    responses: entitlementActionResponse,
}), async (c) => {
    const entitlementId = c.req.valid("param").id;
    const { orderId } = await resetDigitalEntitlement(c.get("db"), entitlementId);
    return ok(c, { entitlementId, orderId });
});

adminDigitalEntitlementRoutes.openapi(createRoute({
    method: "post",
    path: "/{id}/revoke",
    operationId: "dashboard.digital_entitlements.revoke",
    tags: [TAG],
    summary: "Revoke a buyer's access to a delivered file or licence keys",
    request: { params: idParam },
    responses: entitlementActionResponse,
}), async (c) => {
    const entitlementId = c.req.valid("param").id;
    const { orderId } = await revokeDigitalEntitlement(c.get("db"), entitlementId);
    return ok(c, { entitlementId, orderId });
});
