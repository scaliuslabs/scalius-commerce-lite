// Buyer uploads (COMMERCE-HOOKS H17): a file the buyer gives an app's `file`
// line input or checkout attribute, and the signed stream staff and the
// owning app read it by.
//
//   POST   /orders/uploads                     upload one file (multipart: file, field, productId)
//   DELETE /orders/uploads/{id}                take a file back before ordering
//   GET    /orders/uploads/{id}/{exp}/{sig}    stream an ordered file (signed link, 5 minutes)
//
// Every upload passes both limiters (RL_STRICT and RL_STANDARD per IP), is
// read whole (bounded by the input's and the plan's size), typed from its
// bytes and stored privately under `private/buyer-uploads/`. The visitor is
// known by a keyed hash of the address, never the address. Logs carry ids
// only: never a file name, its bytes or a link.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
    buyerUploadVisitorKey,
    readAttachedBuyerUpload,
    removeStagedBuyerUpload,
    stageBuyerUpload,
    verifyBuyerUploadLink,
} from "@scalius/core/modules/buyer-uploads";
import { listActiveFunctionRegistrations } from "@scalius/core/modules/plugins";
import { AppError } from "@scalius/core/errors";
import {
    BUYER_UPLOAD_ID_PATTERN,
    BUYER_UPLOAD_TYPES,
    buyerUploadBounds,
    type BuyerFileBounds,
} from "@scalius/shared/buyer-uploads";
import { appScopedKeyAppId } from "@scalius/shared/plugins/ids";
import { contentDispositionAttachment } from "@scalius/shared/digital";
import { created, ok } from "../../utils/api-response";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { getTrustedClientIp } from "../../utils/client-ip";
import { errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { createCheckoutAppFunctions } from "../../plugins/checkout-functions";

const app = new OpenAPIHono<{ Bindings: Env }>();

/** Multipart framing on top of the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function noStore(c: Context) {
    c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
}

const uploadIdSchema = z.string().regex(BUYER_UPLOAD_ID_PATTERN).openapi({ description: "An upload id, `bup_` and 24 characters." });

export const stagedBuyerUploadSchema = z.object({
    id: uploadIdSchema,
    filename: z.string(),
    mediaType: z.enum(BUYER_UPLOAD_TYPES),
    sizeBytes: z.number().int(),
}).openapi("StagedBuyerUpload");

/**
 * The `file` input the field names, as checkout reads it: an active app's
 * line input (`line`) or checkout attribute (`attribute`), with the plan's
 * bounds. Unknown, or not a file input: 400 `upload_input_unknown`.
 */
async function resolveFileInput(
    c: Context<{ Bindings: Env }>,
    fieldKey: string,
    target: "line" | "attribute",
): Promise<{ appId: string; bounds: BuyerFileBounds }> {
    const appId = appScopedKeyAppId(fieldKey);
    const unknown = () => new AppError(400, "upload_input_unknown", "This field does not take files.");
    if (!appId) throw unknown();
    const key = fieldKey.slice(appId.length + 1);
    const db = c.get("db");
    const apps = createCheckoutAppFunctions({ env: c.env, db, registrations: await listActiveFunctionRegistrations(db), ctx: undefined, buyerRequest: null });
    const declaration = target === "line"
        ? apps.lineInputs?.find((entry) => entry.appId === appId)?.inputs.find((input) => input.key === key)
        : apps.attributes?.find((entry) => entry.appId === appId)?.fields.find((field) => field.key === key);
    if (!declaration || declaration.type !== "file") throw unknown();
    return { appId, bounds: buyerUploadBounds(declaration) };
}

app.openapi(createRoute({
    method: "post",
    path: "/uploads",
    operationId: "storefront.orders_uploads.create",
    tags: ["Orders"],
    summary: "Upload one file for an app's file input (a line input or a checkout attribute)",
    description: "Multipart form: `file`, `field` (`<app id>.<key>`), `target` (`line` or `attribute`) and, for a line input, `productId`. The type is read from the bytes; the file stays private. Send the returned id as the input's answer (ids joined by commas). Files no order takes within 72 hours are deleted.",
    request: {
        body: {
            required: true,
            content: {
                "multipart/form-data": {
                    schema: z.object({
                        file: z.any().openapi({ type: "string", format: "binary" }),
                        field: z.string().max(160),
                        target: z.enum(["line", "attribute"]),
                        productId: z.string().max(128).optional(),
                    }),
                },
            },
        },
    },
    responses: {
        201: { description: "The stored upload", content: { "application/json": { schema: successEnvelope(z.object({ upload: stagedBuyerUploadSchema })) } } },
        ...errorResponses,
        503: serviceUnavailableResponse,
    },
}), async (c) => {
    noStore(c);
    const ip = getTrustedClientIp(c);
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    // The plan's ceiling: no input takes more, so a larger body is refused before it is read.
    if (declaredLength > buyerUploadBounds({}).maxBytes + MULTIPART_OVERHEAD_BYTES) {
        throw new AppError(413, "upload_too_large", "This file is too large.");
    }
    let form: FormData;
    try {
        form = await c.req.formData();
    } catch {
        throw new ValidationError("Upload one file as multipart form data.");
    }
    const text = (name: string) => {
        const value = form.get(name);
        return typeof value === "string" ? value.trim().slice(0, 160) : "";
    };
    const target = text("target");
    if (target !== "line" && target !== "attribute") throw new ValidationError("target must be line or attribute.");
    const fieldKey = text("field");
    const productId = target === "line" ? text("productId") : "";
    if (target === "line" && !productId) throw new ValidationError("A line input's upload names its product.");
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ValidationError("Choose a file to upload.");
    const { appId, bounds } = await resolveFileInput(c, fieldKey, target);
    if (file.size > bounds.maxBytes) {
        throw new AppError(400, "upload_too_large", "This file is too large.", { maxBytes: bounds.maxBytes });
    }
    const upload = await stageBuyerUpload(c.get("db"), c.env.BUCKET, {
        appId,
        fieldKey,
        target,
        productId: target === "line" ? productId : null,
        bounds,
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        uploaderKey: await buyerUploadVisitorKey(c.env, ip),
    });
    return created(c, { upload });
});

app.openapi(createRoute({
    method: "delete",
    path: "/uploads/{id}",
    operationId: "storefront.orders_uploads.delete",
    tags: ["Orders"],
    summary: "Take back a file no order holds yet",
    description: "Only from the visitor that uploaded it; anything else is 404.",
    request: { params: z.object({ id: uploadIdSchema }) },
    responses: {
        200: { description: "Removed", content: { "application/json": { schema: successEnvelope(z.object({ removed: z.literal(true) })) } } },
        ...errorResponses,
    },
}), async (c) => {
    noStore(c);
    const ip = getTrustedClientIp(c);
    await removeStagedBuyerUpload(c.get("db"), c.env.BUCKET, {
        id: c.req.valid("param").id,
        uploaderKey: await buyerUploadVisitorKey(c.env, ip),
    });
    return ok(c, { removed: true as const });
});

app.openapi(createRoute({
    method: "get",
    path: "/uploads/{id}/{exp}/{sig}",
    operationId: "storefront.orders_uploads.get",
    tags: ["Orders"],
    summary: "Stream an ordered buyer file from a signed link",
    description: "The link comes from `order_uploads.list` (staff or the owning app) and lives 5 minutes. Every failure is 404.",
    request: { params: z.object({ id: z.string().max(40), exp: z.string().max(12), sig: z.string().max(64) }) },
    responses: {
        200: { description: "The file, as an attachment", content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } },
        404: errorResponses[404],
    },
}), (async (c: Context<{ Bindings: Env }>) => {
    const params = c.req.param() as { id: string; exp: string; sig: string };
    const expiresAt = /^\d{1,12}$/u.test(params.exp) ? Number(params.exp) : Number.NaN;
    const valid = await verifyBuyerUploadLink(c.env, { uploadId: params.id, expiresAt, signature: params.sig }).catch(() => false);
    const upload = valid ? await readAttachedBuyerUpload(c.get("db"), params.id) : null;
    const object = upload ? await c.env.BUCKET.get(upload.r2Key) : null;
    if (!upload || !object || !("body" in object) || !object.body) throw new NotFoundError("File not found");
    return new Response(object.body, {
        status: 200,
        headers: {
            "Content-Type": upload.mediaType,
            "Content-Length": String(upload.sizeBytes),
            "Content-Disposition": contentDispositionAttachment(upload.filename),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Referrer-Policy": "no-referrer",
            "Cross-Origin-Resource-Policy": "same-site",
        },
    });
}) as never);

export { app as buyerUploadRoutes };
