// Guest downloads and licence keys (Wave B design §3.4, §7.1), and the
// cookie-bound ticket stream shared with signed-in buyers.
//
//   GET  /orders/receipt/{id}/downloads                         what the order delivered
//   POST /orders/receipt/{id}/downloads/{entitlementId}/ticket  count one download, mint a ticket
//   POST /orders/receipt/{id}/licence-keys/{keyId}/reveal       one key's plaintext (no-store)
//   GET  /orders/downloads/{entitlementId}/{exp}/{sig}          stream the file (Range)
//
// The receipt proof travels only in the X-Receipt-Token header (the storefront
// reads it from the order's httpOnly cookie); URLs carry ids and a signature.
// A ticket is bound to the proof it was minted with, so the stream needs that
// same proof again: a logged or forwarded URL alone is a 404.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    listBuyerDownloads,
    mintDownloadTicket,
    openDownloadTicket,
    revealLicenceKey,
    type BuyerDigitalLine,
    type DigitalBuyerAccess,
    type DownloadTicket,
} from "@scalius/core/modules/digital";
import { contentDispositionAttachment } from "@scalius/shared/digital";
import type { Context } from "hono";
import { ok } from "../../utils/api-response";
import { NotFoundError, RateLimitError, ServiceUnavailableError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { isWithinRateLimit } from "../../utils/rate-limit";
import { getTrustedClientIp } from "../../utils/client-ip";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { getCustomerSessionTokenFromRequest } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";

// ─── Shared schemas (the account routes use them too) ────────────────────

export const buyerDownloadFileSchema = z.object({
    entitlementId: z.string(),
    displayName: z.string(),
    filename: z.string().nullable(),
    sizeBytes: z.number().int().nullable(),
    downloadCount: z.number().int(),
    downloadLimit: z.number().int().nullable().openapi({ description: "Null: unlimited." }),
    expiresAt: z.string().nullable().openapi({ format: "date-time", description: "When access ends; null: never." }),
    revoked: z.boolean(),
    available: z.boolean().openapi({ description: "Downloadable right now (not revoked, expired or used up)." }),
}).openapi("BuyerDownloadFile");

export const buyerLicenceKeySchema = z.object({
    keyId: z.string(),
    last4: z.string().openapi({ description: "The key's last characters; reveal the key with a POST." }),
}).openapi("BuyerLicenceKey");

export const buyerDigitalLineSchema = z.object({
    orderId: z.string(),
    orderNumber: z.number().int().nullable(),
    orderItemId: z.string(),
    productName: z.string().nullable(),
    variantLabel: z.string().nullable(),
    deliveredAt: z.string().openapi({ format: "date-time" }),
    files: z.array(buyerDownloadFileSchema),
    licenceKeys: z.array(buyerLicenceKeySchema),
}).openapi("BuyerDigitalLine");

export const downloadTicketSchema = z.object({
    href: z.string().openapi({ description: "Storefront path of the 10-minute download, bound to this browser's cookie." }),
    expiresAt: z.string().openapi({ format: "date-time" }),
    downloadCount: z.number().int(),
    downloadLimit: z.number().int().nullable(),
}).openapi("DownloadTicket");

export const revealedLicenceKeySchema = z.object({
    keyId: z.string(),
    key: z.string(),
    last4: z.string(),
}).openapi("RevealedLicenceKey");

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export function presentBuyerDigitalLines(lines: readonly BuyerDigitalLine[]) {
    return lines.map((line) => ({
        ...line,
        deliveredAt: iso(line.deliveredAt),
        files: line.files.map((file) => ({ ...file, expiresAt: file.expiresAt === null ? null : iso(file.expiresAt) })),
    }));
}

/**
 * The storefront route that streams a ticket and knows which cookie to send:
 * `/api/downloads/account/<entitlementId>/<exp>/<sig>` (the session) or
 * `/api/downloads/order/<orderId>/<entitlementId>/<exp>/<sig>` (that order's receipt proof).
 */
export function presentDownloadTicket(ticket: DownloadTicket, access: DigitalBuyerAccess) {
    const prefix = access.kind === "customer" ? "/api/downloads/account" : `/api/downloads/order/${encodeURIComponent(access.orderId)}`;
    return {
        href: `${prefix}/${ticket.path}`,
        expiresAt: iso(ticket.expiresAt),
        downloadCount: ticket.downloadCount,
        downloadLimit: ticket.downloadLimit,
    };
}

export function setNoStore(c: Context): void {
    c.header("Cache-Control", "private, no-store");
    c.header("Pragma", "no-cache");
}

/** Download mints and key reveals: RL_STANDARD per IP and purpose; fails closed without the binding. */
export async function enforceDigitalBuyerLimit(c: Context<{ Bindings: Env }>, purpose: "download_ticket" | "licence_key_reveal"): Promise<void> {
    if (!(await isWithinRateLimit(c.env, "RL_STANDARD", `digital:${purpose}`, getTrustedClientIp(c) ?? "unknown"))) {
        throw new RateLimitError("Too many requests. Wait a minute and try again.", 60);
    }
}

export const downloadTicketResponses = {
    200: { description: "Ticket minted", content: { "application/json": { schema: successEnvelope(downloadTicketSchema) } } },
    ...errorResponses,
    409: { ...conflictResponse, description: "Download limit reached (DOWNLOAD_LIMIT_REACHED)" },
    410: { ...conflictResponse, description: "Access revoked or ended (DOWNLOAD_REVOKED, DOWNLOAD_EXPIRED)" },
    503: serviceUnavailableResponse,
};

export const revealResponses = {
    200: { description: "The licence key", content: { "application/json": { schema: successEnvelope(revealedLicenceKeySchema) } } },
    ...errorResponses,
    503: serviceUnavailableResponse,
};

// ─── Receipt (guest) ─────────────────────────────────────────────────────

async function receiptAccess(c: Context<{ Bindings: Env }>, orderId: string): Promise<{ access: DigitalBuyerAccess; proof: string }> {
    const token = c.req.header(RECEIPT_TOKEN_HEADER)?.trim();
    await validateReceiptToken(c.env.CACHE, orderId, token, c.get("db"));
    return { access: { kind: "receipt", orderId }, proof: token! };
}

const receiptParam = z.object({ id: z.string().min(1).max(80) });

app.openapi(createRoute({
    method: "get",
    path: "/receipt/{id}/downloads",
    tags: ["Orders"],
    summary: "Downloads and licence keys an order delivered (receipt proof in X-Receipt-Token)",
    request: { params: receiptParam },
    responses: {
        200: { description: "Delivered items", content: { "application/json": { schema: successEnvelope(z.object({ lines: z.array(buyerDigitalLineSchema) })) } } },
        ...errorResponses,
    },
}), async (c) => {
    setNoStore(c);
    const { access } = await receiptAccess(c, c.req.valid("param").id);
    return ok(c, { lines: presentBuyerDigitalLines(await listBuyerDownloads(c.get("db"), access)) });
});

app.openapi(createRoute({
    method: "post",
    path: "/receipt/{id}/downloads/{entitlementId}/ticket",
    tags: ["Orders"],
    summary: "Count one download of a file and get its short-lived, cookie-bound link",
    request: { params: receiptParam.extend({ entitlementId: z.string().min(1).max(80) }) },
    responses: downloadTicketResponses,
}), async (c) => {
    setNoStore(c);
    await enforceDigitalBuyerLimit(c, "download_ticket");
    const { id, entitlementId } = c.req.valid("param");
    const { access, proof } = await receiptAccess(c, id);
    const ticket = await mintDownloadTicket(c.get("db"), c.env, { entitlementId, access, proof });
    return ok(c, presentDownloadTicket(ticket, access));
});

app.openapi(createRoute({
    method: "post",
    path: "/receipt/{id}/licence-keys/{keyId}/reveal",
    tags: ["Orders"],
    summary: "Show one licence key the order received",
    request: { params: receiptParam.extend({ keyId: z.string().min(1).max(80) }) },
    responses: revealResponses,
}), async (c) => {
    setNoStore(c);
    await enforceDigitalBuyerLimit(c, "licence_key_reveal");
    const { id, keyId } = c.req.valid("param");
    const { access } = await receiptAccess(c, id);
    return ok(c, await revealLicenceKey(c.get("db"), getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>), { keyId, access }));
});

// ─── The stream ──────────────────────────────────────────────────────────

/** A single `bytes=` range against a file of `size` bytes; `null` = whole file, `"unsatisfiable"` = 416. */
export function parseByteRange(header: string | undefined, size: number): { offset: number; length: number } | null | "unsatisfiable" {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (match[1] === "" && match[2] === "")) return null;
    if (match[1] === "") {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
        const length = Math.min(suffix, size);
        return { offset: size - length, length };
    }
    const start = Number(match[1]);
    const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return "unsatisfiable";
    return { offset: start, length: end - start + 1 };
}

app.openapi(createRoute({
    method: "get",
    path: "/downloads/{entitlementId}/{exp}/{sig}",
    tags: ["Orders"],
    summary: "Stream a purchased file with a download ticket (proof in X-Receipt-Token or the session)",
    description: "The ticket only works with the proof it was minted with. Supports Range for resuming; resuming within the ticket's 10 minutes does not count as another download.",
    request: {
        params: z.object({
            entitlementId: z.string().min(1).max(80),
            exp: z.coerce.number().int(),
            sig: z.string().min(1).max(64),
        }),
    },
    responses: {
        200: { description: "The file", content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } },
        206: { description: "Part of the file", content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } },
        404: errorResponses[404],
        416: { description: "Range not satisfiable" },
        503: serviceUnavailableResponse,
    },
}), async (c) => {
    const { entitlementId, exp, sig } = c.req.valid("param");
    const proof = c.req.header(RECEIPT_TOKEN_HEADER)?.trim() || getCustomerSessionTokenFromRequest(c) || null;
    const file = await openDownloadTicket(c.get("db"), c.env, { entitlementId, expiresAt: exp, signature: sig, proof });
    const bucket = c.env.BUCKET;
    if (!bucket) throw new ServiceUnavailableError("Downloads are unavailable right now.");
    const head = file.sizeBytes ?? (await bucket.head(file.r2Key))?.size;
    if (head === undefined) throw new NotFoundError("Download not found");
    const headers = new Headers({
        "Content-Type": "application/octet-stream",
        "Content-Disposition": contentDispositionAttachment(file.filename),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "private, no-store",
        "Accept-Ranges": "bytes",
        "Referrer-Policy": "no-referrer",
    });
    const range = parseByteRange(c.req.header("range"), head);
    if (range === "unsatisfiable") {
        headers.set("Content-Range", `bytes */${head}`);
        return new Response(null, { status: 416, headers }) as never;
    }
    const object = await bucket.get(file.r2Key, range ? { range } : undefined);
    if (!object || !("body" in object) || !object.body) throw new NotFoundError("Download not found");
    if (range) {
        headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head}`);
        headers.set("Content-Length", String(range.length));
        return new Response(object.body, { status: 206, headers }) as never;
    }
    headers.set("Content-Length", String(head));
    return new Response(object.body, { status: 200, headers }) as never;
});

export { app as receiptDownloadRoutes };
