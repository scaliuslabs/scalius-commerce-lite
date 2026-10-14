import { getBuyerConversationView } from "../../utils/conversation-view";
// Guest order conversation routes (Wave A §6.1). The receipt proof travels in
// the X-Receipt-Token header (or the JSON body of a post), never the URL; the
// storefront keeps it in an HttpOnly cookie and adds the header server-side.
// Guests can only use their order's thread (§15 q6).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  getOrCreateOrderThread,
  markBuyerRead,
  postBuyerOrderMessage,
  readOrderThread,
  readConversationCartShare,
  shareConversationCart,
  withdrawConversationCart,
  resolveBuyerThread,
  resolveConversationAttachment,
  stageConversationAttachment,
  type ConversationActor,
} from "@scalius/core/modules/conversations";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import {
  attachmentUploadRequest,
  attachmentUploadResponseSchema,
  buyerMessagePageQuerySchema,
  buyerConversationThreadSchema,
  buyerPostBodySchema,
  cartShareSchema,
  cartSharePutBodySchema,
  cartShareDeleteBodySchema,
  conversationAttachmentIdSchema,
  readBodySchema,
} from "../../schemas/conversations";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import {
  enforceBuyerWriteLimits,
  formText,
  readAttachmentImage,
  readAttachmentForm,
  serveConversationAttachment,
} from "../../utils/conversation-http";
import { NotFoundError } from "../../utils/api-error";
import { prepareConversationCartLines, projectConversationCartShare } from "../../utils/conversation-cart-share";
import { notificationSender } from "../../background/notification-sender";

const app = new OpenAPIHono<{ Bindings: Env }>();

const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";
const orderIdParam = z.object({ id: z.string().trim().min(1).max(128) });
const receiptHeaders = z.object({ "x-receipt-token": z.string().optional() });

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
}

/** Validates the receipt proof for this order and returns the guest actor. */
async function receiptActor(
  c: Context<{ Bindings: Env }>,
  orderId: string,
  bodyToken?: string,
): Promise<ConversationActor> {
  const token = c.req.header(RECEIPT_TOKEN_HEADER)?.trim() || bodyToken?.trim() || undefined;
  await validateReceiptToken(c.get("db"), orderId, token);
  return { kind: "guest_receipt", orderId };
}

const threadEnvelope = successEnvelope(z.object({ conversation: buyerConversationThreadSchema.nullable() }));

app.openapi(createRoute({
  method: "get",
  path: "/receipt/{id}/conversation",
  tags: ["Orders"],
  summary: "Read the order's conversation with a receipt proof (header only)",
  request: { params: orderIdParam, headers: receiptHeaders, query: buyerMessagePageQuerySchema },
  responses: {
    200: { description: "The order thread, or null before anyone wrote", content: { "application/json": { schema: threadEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const orderId = c.req.valid("param").id;
  await receiptActor(c, orderId);
  const thread = await readOrderThread(c.get("db"), orderId);
  const conversation = thread && thread.lastSeq > 0
    ? await getBuyerConversationView(c.get("db"), thread, c.req.valid("query"))
    : null;
  return ok(c, { conversation });
});

app.openapi(createRoute({
  method: "post",
  path: "/receipt/{id}/conversation",
  tags: ["Orders"],
  summary: "Post a message on the order's conversation with a receipt proof",
  request: {
    params: orderIdParam,
    headers: receiptHeaders,
    body: {
      required: true,
      content: { "application/json": { schema: buyerPostBodySchema.extend({ token: z.string().optional() }).strict() } },
    },
  },
  responses: {
    201: { description: "Posted; the thread after the post", content: { "application/json": { schema: threadEnvelope } } },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  noStore(c);
  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  const actor = await receiptActor(c, orderId, body.token);
  await enforceBuyerWriteLimits(c, "post", { orderId });
  const posted = await postBuyerOrderMessage(db, orderId, {
    actor,
    body: body.body,
    clientMessageKey: body.clientMessageKey,
    attachmentIds: body.attachmentIds,
  }, { send: notificationSender(c) });
  const thread = await resolveBuyerThread(db, actor, posted.conversationId);
  return created(c, { conversation: await getBuyerConversationView(db, thread) });
});

app.openapi(createRoute({
  method: "post",
  path: "/receipt/{id}/conversation/read",
  tags: ["Orders"],
  summary: "Mark the order's conversation read up to a message",
  request: {
    params: orderIdParam,
    headers: receiptHeaders,
    body: { required: true, content: { "application/json": { schema: readBodySchema.extend({ token: z.string().optional() }).strict() } } },
  },
  responses: {
    200: { description: "Read marker", content: { "application/json": { schema: successEnvelope(z.object({ readSeq: z.number().int() })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  await receiptActor(c, orderId, body.token);
  const thread = await readOrderThread(c.get("db"), orderId);
  if (!thread) throw new NotFoundError("Conversation not found");
  return ok(c, { readSeq: await markBuyerRead(c.get("db"), thread, body.seq) });
});

app.openapi(createRoute({
  method: "post",
  path: "/receipt/{id}/conversation-attachments",
  tags: ["Orders"],
  summary: "Upload one image (JPEG, PNG or WebP, 5 MB or less) for the order's conversation",
  description: "Multipart form with `file`. The image is re-encoded to WebP (metadata removed) and stays private; attach it by id on the next post within an hour.",
  request: { params: orderIdParam, headers: receiptHeaders, body: { required: true, ...attachmentUploadRequest } },
  responses: {
    201: { description: "Staged attachment", content: { "application/json": { schema: successEnvelope(attachmentUploadResponseSchema) } } },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  noStore(c);
  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  const form = await readAttachmentForm(c);
  const actor = await receiptActor(c, orderId, formText(form, "token") ?? undefined);
  await enforceBuyerWriteLimits(c, "upload", { orderId });
  const image = await readAttachmentImage(form);
  const thread = await getOrCreateOrderThread(db, orderId);
  const staged = await stageConversationAttachment(db, c.env.BUCKET, { conversationId: thread.id, actor, ...image });
  return created(c, { attachmentId: staged.id, ...staged });
});

app.openapi(createRoute({
  method: "get",
  path: "/receipt/{id}/conversation/attachments/{attachmentId}",
  tags: ["Orders"],
  summary: "Read one image of the order's conversation with a receipt proof (header only)",
  request: {
    params: orderIdParam.extend({ attachmentId: conversationAttachmentIdSchema }),
    headers: receiptHeaders,
  },
  responses: {
    200: { description: "The re-encoded image", content: { "image/webp": { schema: z.string().openapi({ format: "binary" }) } } },
    ...errorResponses,
  },
}), async (c) => {
  const { id: orderId, attachmentId } = c.req.valid("param");
  const actor = await receiptActor(c, orderId);
  const thread = await readOrderThread(c.get("db"), orderId);
  if (!thread) throw new NotFoundError("Attachment not found");
  await resolveBuyerThread(c.get("db"), actor, thread.id);
  const attachment = await resolveConversationAttachment(c.get("db"), { conversationId: thread.id, attachmentId, reader: actor });
  return serveConversationAttachment(c.env, attachment);
});

app.openapi(createRoute({
  method: "get",
  path: "/receipt/{id}/conversation/cart-share",
  operationId: "storefront.orders_receipt_conversation_cart_share.get",
  tags: ["Orders"],
  summary: "Read the order conversation cart with receipt proof (header only)",
  request: { params: orderIdParam, headers: receiptHeaders },
  responses: {
    200: { description: "Shared cart", content: { "application/json": { schema: successEnvelope(z.object({ cartShare: cartShareSchema.nullable() })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  await receiptActor(c, orderId);
  const thread = await readOrderThread(db, orderId);
  const share = thread ? await readConversationCartShare(db, thread.id) : null;
  return ok(c, { cartShare: share ? await projectConversationCartShare(db, share, { orderId }) : null });
});

app.openapi(createRoute({
  method: "put",
  path: "/receipt/{id}/conversation/cart-share",
  operationId: "storefront.orders_receipt_conversation_cart_share.put",
  tags: ["Orders"],
  summary: "Explicitly share or update the order conversation cart with receipt proof (header only)",
  request: { params: orderIdParam, headers: receiptHeaders, body: { required: true, content: { "application/json": { schema: cartSharePutBodySchema } } } },
  responses: {
    200: { description: "Shared cart", content: { "application/json": { schema: successEnvelope(z.object({ cartShare: cartShareSchema })) } } },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  noStore(c);
  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  const actor = await receiptActor(c, orderId);
  await enforceBuyerWriteLimits(c, "cart-share", { orderId });
  const body = c.req.valid("json");
  const lines = await prepareConversationCartLines(db, body.lines, { orderId });
  const thread = await getOrCreateOrderThread(db, orderId);
  const share = await shareConversationCart(db, actor, thread.id, { lines, expectedVersion: body.expectedVersion });
  return ok(c, { cartShare: await projectConversationCartShare(db, share, { orderId }) });
});

app.openapi(createRoute({
  method: "delete",
  path: "/receipt/{id}/conversation/cart-share",
  operationId: "storefront.orders_receipt_conversation_cart_share.delete",
  tags: ["Orders"],
  summary: "Withdraw the order conversation cart with receipt proof (header only)",
  request: { params: orderIdParam, headers: receiptHeaders, body: { required: true, content: { "application/json": { schema: cartShareDeleteBodySchema } } } },
  responses: {
    200: { description: "Shared cart", content: { "application/json": { schema: successEnvelope(z.object({ cartShare: cartShareSchema })) } } },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  noStore(c);
  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  const actor = await receiptActor(c, orderId);
  const thread = await readOrderThread(db, orderId);
  if (!thread) throw new NotFoundError("Conversation not found");
  await enforceBuyerWriteLimits(c, "cart-share", { orderId });
  const share = await withdrawConversationCart(db, actor, thread.id, c.req.valid("json").expectedVersion);
  return ok(c, { cartShare: await projectConversationCartShare(db, share, { orderId }) });
});

export { app as orderConversationRoutes };
