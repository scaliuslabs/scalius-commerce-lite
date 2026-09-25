// Signed-in buyer conversation routes (Wave A §6.1): the account Inbox (store
// threads of verified accounts and the threads of orders the account owns),
// order threads, reads, posts and private image attachments. Message
// endpoints accept no contact fields; bodies never enter URLs or logs.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  assertBuyerOrderAccess,
  countBuyerUnread,
  createStoreThread,
  getBuyerThread,
  getOrCreateOrderThread,
  isVerifiedCustomerAccount,
  listBuyerThreads,
  markBuyerRead,
  postBuyerOrderMessage,
  postConversationMessage,
  readOrderThread,
  resolveBuyerThread,
  resolveConversationAttachment,
  stageConversationAttachment,
  type ConversationActor,
} from "@scalius/core/modules/conversations";
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import {
  attachmentUploadRequest,
  attachmentUploadResponseSchema,
  beforeSeqQuerySchema,
  buyerConversationSummarySchema,
  buyerConversationThreadSchema,
  buyerPostBodySchema,
  clientMessageKeySchema,
  conversationAttachmentIdSchema,
  conversationIdSchema,
  readBodySchema,
} from "../../schemas/conversations";
import {
  enforceBuyerWriteLimits,
  formText,
  readAndReencodeAttachment,
  readAttachmentForm,
  serveConversationAttachment,
} from "../../utils/conversation-http";
import { UnauthorizedError, ValidationError } from "../../utils/api-error";
import { requireCustomerSession, setPrivateNoStoreHeaders } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

async function customerActor(c: Context<{ Bindings: Env }>): Promise<{ customerId: string; actor: ConversationActor }> {
  const { session } = await requireCustomerSession(c);
  if (!session.customerId) throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  return { customerId: session.customerId, actor: { kind: "customer", customerId: session.customerId } };
}

const conversationParam = z.object({ id: conversationIdSchema });
const orderParam = z.object({ id: z.string().trim().min(1).max(128) });
const threadEnvelope = successEnvelope(z.object({ conversation: buyerConversationThreadSchema }));
const nullableThreadEnvelope = successEnvelope(z.object({ conversation: buyerConversationThreadSchema.nullable() }));
const writeResponses = { ...errorResponses, 409: conflictResponse, 503: serviceUnavailableResponse };

app.openapi(createRoute({
  method: "get",
  path: "/conversations",
  tags: ["Customer Auth"],
  summary: "List the account's conversations, newest first",
  request: { query: z.object({ cursor: z.string().max(100).optional() }) },
  responses: {
    200: {
      description: "Conversations (20 per page) and whether the account may start a store conversation",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            items: z.array(buyerConversationSummarySchema),
            nextCursor: z.string().nullable(),
            canStartStoreConversation: z.boolean(),
          })),
        },
      },
    },
    ...errorResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { customerId } = await customerActor(c);
  const db = c.get("db");
  const [page, verified] = await Promise.all([
    listBuyerThreads(db, customerId, { cursor: c.req.valid("query").cursor }),
    isVerifiedCustomerAccount(db, customerId),
  ]);
  return ok(c, { ...page, canStartStoreConversation: verified });
});

app.openapi(createRoute({
  method: "get",
  path: "/conversations/unread",
  tags: ["Customer Auth"],
  summary: "Unread replies across the account's conversations (the Inbox badge)",
  responses: {
    200: { description: "Unread count", content: { "application/json": { schema: successEnvelope(z.object({ unread: z.number().int() })) } } },
    ...errorResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { customerId } = await customerActor(c);
  return ok(c, { unread: await countBuyerUnread(c.get("db"), customerId) });
});

app.openapi(createRoute({
  method: "post",
  path: "/conversations",
  tags: ["Customer Auth"],
  summary: "Start a conversation with the store (verified accounts only)",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            subject: z.string().max(CONVERSATION_LIMITS.subjectLength * 2),
            body: z.string().max(CONVERSATION_LIMITS.bodyLength * 2),
            clientMessageKey: clientMessageKeySchema,
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: { description: "The new conversation", content: { "application/json": { schema: threadEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { customerId, actor } = await customerActor(c);
  const db = c.get("db");
  const body = c.req.valid("json");
  await enforceBuyerWriteLimits(c, "store-thread", { customerId });
  const posted = await createStoreThread(db, customerId, body, { queue: c.env.JOBS_QUEUE });
  const thread = await resolveBuyerThread(db, actor, posted.conversationId);
  return created(c, { conversation: await getBuyerThread(db, thread) });
});

app.openapi(createRoute({
  method: "get",
  path: "/conversations/{id}",
  tags: ["Customer Auth"],
  summary: "Read one conversation (50 messages per page, public lines only)",
  request: { params: conversationParam, query: beforeSeqQuerySchema },
  responses: {
    200: { description: "The conversation", content: { "application/json": { schema: threadEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { actor } = await customerActor(c);
  const db = c.get("db");
  const thread = await resolveBuyerThread(db, actor, c.req.valid("param").id);
  return ok(c, { conversation: await getBuyerThread(db, thread, { beforeSeq: c.req.valid("query").beforeSeq }) });
});

app.openapi(createRoute({
  method: "post",
  path: "/conversations/{id}/messages",
  tags: ["Customer Auth"],
  summary: "Post a message on a conversation",
  request: { params: conversationParam, body: { required: true, content: { "application/json": { schema: buyerPostBodySchema } } } },
  responses: {
    201: { description: "Posted; the conversation after the post", content: { "application/json": { schema: threadEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { customerId, actor } = await customerActor(c);
  const db = c.get("db");
  const body = c.req.valid("json");
  const thread = await resolveBuyerThread(db, actor, c.req.valid("param").id);
  await enforceBuyerWriteLimits(c, "post", { customerId });
  await postConversationMessage(db, thread, {
    actor,
    body: body.body,
    clientMessageKey: body.clientMessageKey,
    attachmentIds: body.attachmentIds,
  }, { queue: c.env.JOBS_QUEUE });
  const fresh = await resolveBuyerThread(db, actor, thread.id);
  return created(c, { conversation: await getBuyerThread(db, fresh) });
});

app.openapi(createRoute({
  method: "post",
  path: "/conversations/{id}/read",
  tags: ["Customer Auth"],
  summary: "Mark a conversation read up to a message",
  request: { params: conversationParam, body: { required: true, content: { "application/json": { schema: readBodySchema } } } },
  responses: {
    200: { description: "Read marker", content: { "application/json": { schema: successEnvelope(z.object({ readSeq: z.number().int() })) } } },
    ...errorResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { actor } = await customerActor(c);
  const db = c.get("db");
  const thread = await resolveBuyerThread(db, actor, c.req.valid("param").id);
  return ok(c, { readSeq: await markBuyerRead(db, thread, c.req.valid("json").seq) });
});

app.openapi(createRoute({
  method: "get",
  path: "/orders/{id}/conversation",
  tags: ["Customer Auth"],
  summary: "Read an owned order's conversation, or null before anyone wrote",
  request: { params: orderParam, query: beforeSeqQuerySchema },
  responses: {
    200: { description: "The order thread", content: { "application/json": { schema: nullableThreadEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { actor } = await customerActor(c);
  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  await assertBuyerOrderAccess(db, actor, orderId);
  const thread = await readOrderThread(db, orderId);
  const conversation = thread && thread.lastSeq > 0
    ? await getBuyerThread(db, thread, { beforeSeq: c.req.valid("query").beforeSeq })
    : null;
  return ok(c, { conversation });
});

app.openapi(createRoute({
  method: "post",
  path: "/orders/{id}/conversation",
  tags: ["Customer Auth"],
  summary: "Post on an owned order's conversation (starts it on the first message)",
  request: { params: orderParam, body: { required: true, content: { "application/json": { schema: buyerPostBodySchema } } } },
  responses: {
    201: { description: "Posted; the thread after the post", content: { "application/json": { schema: threadEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { customerId, actor } = await customerActor(c);
  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  await assertBuyerOrderAccess(db, actor, orderId);
  await enforceBuyerWriteLimits(c, "post", { customerId });
  const posted = await postBuyerOrderMessage(db, orderId, {
    actor,
    body: body.body,
    clientMessageKey: body.clientMessageKey,
    attachmentIds: body.attachmentIds,
  }, { queue: c.env.JOBS_QUEUE });
  const thread = await resolveBuyerThread(db, actor, posted.conversationId);
  return created(c, { conversation: await getBuyerThread(db, thread) });
});

app.openapi(createRoute({
  method: "post",
  path: "/conversation-attachments",
  tags: ["Customer Auth"],
  summary: "Upload one image (JPEG, PNG or WebP, 5 MB or less) for a conversation",
  description: "Multipart form with `file` and either `conversationId` or `orderId` (the owned order whose thread to use). The image is re-encoded to WebP (metadata removed) and stays private; attach it by id on the next post within an hour.",
  request: { body: { required: true, ...attachmentUploadRequest } },
  responses: {
    201: { description: "Staged attachment", content: { "application/json": { schema: successEnvelope(attachmentUploadResponseSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const { customerId, actor } = await customerActor(c);
  const db = c.get("db");
  const form = await readAttachmentForm(c);
  const conversationId = formText(form, "conversationId");
  const orderId = formText(form, "orderId");
  if (!conversationId && !orderId) throw new ValidationError("Say which conversation the image is for.");
  const thread = conversationId
    ? await resolveBuyerThread(db, actor, conversationId)
    : await (async () => {
      await assertBuyerOrderAccess(db, actor, orderId!);
      return getOrCreateOrderThread(db, orderId!);
    })();
  await enforceBuyerWriteLimits(c, "upload", { customerId });
  const image = await readAndReencodeAttachment(c.env, form);
  const staged = await stageConversationAttachment(db, c.env.BUCKET, { conversationId: thread.id, actor, ...image });
  return created(c, { attachmentId: staged.id, ...staged });
});

app.openapi(createRoute({
  method: "get",
  path: "/conversations/{id}/attachments/{attachmentId}",
  tags: ["Customer Auth"],
  summary: "Read one image of a conversation",
  request: { params: conversationParam.extend({ attachmentId: conversationAttachmentIdSchema }) },
  responses: {
    200: { description: "The re-encoded image", content: { "image/webp": { schema: z.string().openapi({ format: "binary" }) } } },
    ...errorResponses,
  },
}), async (c) => {
  const { actor } = await customerActor(c);
  const db = c.get("db");
  const { id, attachmentId } = c.req.valid("param");
  const thread = await resolveBuyerThread(db, actor, id);
  const attachment = await resolveConversationAttachment(db, { conversationId: thread.id, attachmentId, reader: actor });
  return serveConversationAttachment(c.env, attachment);
});

export { app as customerConversationRoutes };
