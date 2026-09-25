// Guest warranty claims under /orders/receipt/{id} (Wave B design §5.2, §7.1).
// The receipt proof travels only in the X-Receipt-Token header (the storefront
// reads it from the order's httpOnly cookie); URLs carry ids only. A guest has
// no inbox, so the claim's thread is read, answered and given photos here.
//
//   POST /orders/receipt/{id}/warranties/{warrantyId}/claim-attachments   photo for the claim form
//   POST /orders/receipt/{id}/warranties/{warrantyId}/claims              open a claim
//   GET  /orders/receipt/{id}/warranty-claims/{claimId}                   the claim and its thread
//   POST /orders/receipt/{id}/warranty-claims/{claimId}/messages          reply in the thread
//   POST /orders/receipt/{id}/warranty-claims/{claimId}/attachments       photo for a reply
//   GET  /orders/receipt/{id}/warranty-claims/{claimId}/attachments/{attachmentId}
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  getBuyerThread,
  markBuyerRead,
  postConversationMessage,
  resolveConversationAttachment,
  stageConversationAttachment,
  type ConversationActor,
} from "@scalius/core/modules/conversations";
import {
  openWarrantyClaim,
  readBuyerClaimThread,
  stageWarrantyClaimAttachment,
  type BuyerClaimThread,
} from "@scalius/core/modules/warranty";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import {
  attachmentUploadRequest,
  attachmentUploadResponseSchema,
  beforeSeqQuerySchema,
  buyerConversationThreadSchema,
  buyerPostBodySchema,
  conversationAttachmentIdSchema,
  readBodySchema,
} from "../../schemas/conversations";
import {
  buyerClaimSchema,
  buyerOpenClaimBodySchema,
  claimAttachmentUploadRequest,
  isoFromSeconds,
  openedClaimSchema,
  warrantyClaimIdSchema,
  warrantyIdSchema,
} from "../../schemas/warranty";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import {
  enforceBuyerWriteLimits,
  formText,
  readAndReencodeAttachment,
  readAttachmentForm,
  serveConversationAttachment,
} from "../../utils/conversation-http";

const app = new OpenAPIHono<{ Bindings: Env }>();

const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";
const receiptHeaders = z.object({ "x-receipt-token": z.string().optional() });
const orderId = z.string().trim().min(1).max(128);
const warrantyParams = z.object({ id: orderId, warrantyId: warrantyIdSchema });
const claimParams = z.object({ id: orderId, claimId: warrantyClaimIdSchema });
const writeResponses = { ...errorResponses, 409: conflictResponse, 503: serviceUnavailableResponse };

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
}

/** Validates the receipt proof for this order and returns the guest actor. */
async function receiptActor(c: Context<{ Bindings: Env }>, order: string): Promise<ConversationActor & { kind: "guest_receipt" }> {
  await validateReceiptToken(c.env.CACHE, order, c.req.header(RECEIPT_TOKEN_HEADER)?.trim() || undefined, c.get("db"));
  return { kind: "guest_receipt", orderId: order };
}

function presentClaim(claim: BuyerClaimThread["claim"]) {
  return {
    ...claim,
    createdAt: isoFromSeconds(claim.createdAt),
    closedAt: claim.closedAt === null ? null : isoFromSeconds(claim.closedAt),
  };
}

const claimThreadEnvelope = successEnvelope(z.object({
  claim: buyerClaimSchema,
  conversation: buyerConversationThreadSchema,
}));

app.openapi(createRoute({
  method: "post",
  path: "/receipt/{id}/warranties/{warrantyId}/claim-attachments",
  tags: ["Orders"],
  summary: "Upload one photo for the warranty claim this form is about to open (receipt proof in a header)",
  request: { params: warrantyParams, headers: receiptHeaders, body: { required: true, ...claimAttachmentUploadRequest } },
  responses: {
    201: { description: "Staged photo", content: { "application/json": { schema: successEnvelope(attachmentUploadResponseSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { id, warrantyId } = c.req.valid("param");
  const actor = await receiptActor(c, id);
  const form = await readAttachmentForm(c);
  await enforceBuyerWriteLimits(c, "upload", { orderId: id });
  const image = await readAndReencodeAttachment(c.env, form);
  const staged = await stageWarrantyClaimAttachment(c.get("db"), c.env.BUCKET, {
    warrantyId,
    clientKey: formText(form, "clientKey") ?? "",
    actor,
    ...image,
  });
  return created(c, {
    attachmentId: staged.id,
    conversationId: staged.conversationId,
    mediaType: staged.mediaType,
    sizeBytes: staged.sizeBytes,
    width: staged.width,
    height: staged.height,
  });
});

app.openapi(createRoute({
  method: "post",
  path: "/receipt/{id}/warranties/{warrantyId}/claims",
  tags: ["Orders"],
  summary: "Open a warranty claim for an active warranty of the order (receipt proof in a header)",
  request: {
    params: warrantyParams,
    headers: receiptHeaders,
    body: { required: true, content: { "application/json": { schema: buyerOpenClaimBodySchema } } },
  },
  responses: {
    201: { description: "The claim and its conversation", content: { "application/json": { schema: successEnvelope(openedClaimSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { id, warrantyId } = c.req.valid("param");
  const actor = await receiptActor(c, id);
  const body = c.req.valid("json");
  await enforceBuyerWriteLimits(c, "warranty-claim", { orderId: id });
  const opened = await openWarrantyClaim(c.get("db"), {
    warrantyId,
    actor,
    description: body.description,
    clientKey: body.clientKey,
    attachmentIds: body.attachmentIds,
    quantity: body.quantity,
  }, { queue: c.env.JOBS_QUEUE });
  return created(c, opened);
});

app.openapi(createRoute({
  method: "get",
  path: "/receipt/{id}/warranty-claims/{claimId}",
  tags: ["Orders"],
  summary: "A warranty claim of the order and its conversation (public lines only; receipt proof in a header)",
  request: { params: claimParams, headers: receiptHeaders, query: beforeSeqQuerySchema },
  responses: {
    200: { description: "The claim", content: { "application/json": { schema: claimThreadEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const { id, claimId } = c.req.valid("param");
  const actor = await receiptActor(c, id);
  const db = c.get("db");
  const { claim, thread } = await readBuyerClaimThread(db, actor, claimId);
  return ok(c, {
    claim: presentClaim(claim),
    conversation: await getBuyerThread(db, thread, { beforeSeq: c.req.valid("query").beforeSeq }),
  });
});

app.openapi(createRoute({
  method: "post",
  path: "/receipt/{id}/warranty-claims/{claimId}/messages",
  tags: ["Orders"],
  summary: "Reply in a warranty claim's conversation (receipt proof in a header)",
  request: {
    params: claimParams,
    headers: receiptHeaders,
    body: { required: true, content: { "application/json": { schema: buyerPostBodySchema } } },
  },
  responses: {
    201: { description: "Posted; the claim after the post", content: { "application/json": { schema: claimThreadEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { id, claimId } = c.req.valid("param");
  const actor = await receiptActor(c, id);
  const db = c.get("db");
  const body = c.req.valid("json");
  const { thread } = await readBuyerClaimThread(db, actor, claimId);
  await enforceBuyerWriteLimits(c, "post", { orderId: id });
  await postConversationMessage(db, thread, {
    actor,
    body: body.body,
    clientMessageKey: body.clientMessageKey,
    attachmentIds: body.attachmentIds,
  }, { queue: c.env.JOBS_QUEUE });
  const fresh = await readBuyerClaimThread(db, actor, claimId);
  return created(c, { claim: presentClaim(fresh.claim), conversation: await getBuyerThread(db, fresh.thread) });
});

app.openapi(createRoute({
  method: "post",
  path: "/receipt/{id}/warranty-claims/{claimId}/read",
  tags: ["Orders"],
  summary: "Mark a warranty claim's conversation read up to a message (receipt proof in a header)",
  request: {
    params: claimParams,
    headers: receiptHeaders,
    body: { required: true, content: { "application/json": { schema: readBodySchema } } },
  },
  responses: {
    200: { description: "Read marker", content: { "application/json": { schema: successEnvelope(z.object({ readSeq: z.number().int() })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const { id, claimId } = c.req.valid("param");
  const actor = await receiptActor(c, id);
  const db = c.get("db");
  const { thread } = await readBuyerClaimThread(db, actor, claimId);
  return ok(c, { readSeq: await markBuyerRead(db, thread, c.req.valid("json").seq) });
});

app.openapi(createRoute({
  method: "post",
  path: "/receipt/{id}/warranty-claims/{claimId}/attachments",
  tags: ["Orders"],
  summary: "Upload one photo for a reply in a warranty claim's conversation (receipt proof in a header)",
  request: { params: claimParams, headers: receiptHeaders, body: { required: true, ...attachmentUploadRequest } },
  responses: {
    201: { description: "Staged photo", content: { "application/json": { schema: successEnvelope(attachmentUploadResponseSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { id, claimId } = c.req.valid("param");
  const actor = await receiptActor(c, id);
  const db = c.get("db");
  const { thread } = await readBuyerClaimThread(db, actor, claimId);
  const form = await readAttachmentForm(c);
  await enforceBuyerWriteLimits(c, "upload", { orderId: id });
  const image = await readAndReencodeAttachment(c.env, form);
  const staged = await stageConversationAttachment(db, c.env.BUCKET, { conversationId: thread.id, actor, ...image });
  return created(c, { attachmentId: staged.id, ...staged });
});

app.openapi(createRoute({
  method: "get",
  path: "/receipt/{id}/warranty-claims/{claimId}/attachments/{attachmentId}",
  tags: ["Orders"],
  summary: "Read one photo of a warranty claim's conversation (receipt proof in a header)",
  request: {
    params: claimParams.extend({ attachmentId: conversationAttachmentIdSchema }),
    headers: receiptHeaders,
  },
  responses: {
    200: { description: "The re-encoded image", content: { "image/webp": { schema: z.string().openapi({ format: "binary" }) } } },
    ...errorResponses,
  },
}), async (c) => {
  const { id, claimId, attachmentId } = c.req.valid("param");
  const actor = await receiptActor(c, id);
  const db = c.get("db");
  const { thread } = await readBuyerClaimThread(db, actor, claimId);
  const attachment = await resolveConversationAttachment(db, { conversationId: thread.id, attachmentId, reader: actor });
  return serveConversationAttachment(c.env, attachment);
});

export { app as receiptWarrantyRoutes };
