// Dashboard inbox routes, mounted at /admin/conversations (Wave A §6.2).
// Reads need conversations.view; replies, notes, uploads, status and
// assignment need conversations.reply (route-permissions/conversations.ts).
// Conversation writes are private and never bump the cache generation.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  getOrCreateOrderThread,
  getStaffInboxSummary,
  getStaffOrderThread,
  getStaffThread,
  listStaffInbox,
  markStaffRead,
  postConversationMessage,
  postStaffOrderMessage,
  readThread,
  resolveConversationAttachment,
  stageConversationAttachment,
  updateStaffThread,
  type ConversationActor,
} from "@scalius/core/modules/conversations";
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import {
  attachmentUploadRequest,
  attachmentUploadResponseSchema,
  beforeSeqQuerySchema,
  clientMessageKeySchema,
  conversationAttachmentIdSchema,
  conversationIdSchema,
  readBodySchema,
  staffConversationSummarySchema,
  staffConversationThreadSchema,
} from "../../schemas/conversations";
import {
  formText,
  readAndReencodeAttachment,
  readAttachmentForm,
  serveConversationAttachment,
} from "../../utils/conversation-http";
import { NotFoundError, UnauthorizedError, ValidationError } from "../../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

function staffActor(c: Context<{ Bindings: Env }>): ConversationActor & { kind: "staff" } {
  const user = c.get("user") as { id?: string } | undefined;
  if (!user?.id) throw new UnauthorizedError("Sign in again to use the inbox.");
  return { kind: "staff", userId: user.id };
}

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

const conversationParam = z.object({ id: conversationIdSchema });
const orderParam = z.object({ orderId: z.string().trim().min(1).max(128) });
const threadEnvelope = successEnvelope(z.object({ conversation: staffConversationThreadSchema }));
const writeResponses = { ...errorResponses, 409: conflictResponse };

/** A staff post: a public reply or an internal note, idempotent by `requestKey`. */
const staffPostBodySchema = z.object({
  body: z.string().max(CONVERSATION_LIMITS.bodyLength * 2),
  visibility: z.enum(["public", "internal"]),
  requestKey: clientMessageKeySchema,
  attachmentIds: z.array(conversationAttachmentIdSchema).max(CONVERSATION_LIMITS.attachmentsPerMessage).optional(),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.conversations.list",
  method: "get",
  path: "/",
  tags: ["Admin - Conversations"],
  summary: "List inbox conversations (25 per page, newest activity first)",
  request: {
    query: z.object({
      status: z.enum(["open", "pending", "closed", "all"]).optional(),
      assignee: z.string().max(128).optional().openapi({ description: "`me`, `none` or a staff user id" }),
      subjectType: z.enum(["order", "store"]).optional(),
      q: z.string().max(100).optional().openapi({ description: "Subject, customer name or order number" }),
      cursor: z.string().max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Inbox page",
      content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(staffConversationSummarySchema), nextCursor: z.string().nullable() })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const actor = staffActor(c);
  return ok(c, await listStaffInbox(c.get("db"), actor.userId, c.req.valid("query")));
});

app.openapi(createRoute({
  operationId: "dashboard.conversations.summary",
  method: "get",
  path: "/summary",
  tags: ["Admin - Conversations"],
  summary: "Open conversation counts for the navigation badge",
  responses: {
    200: {
      description: "Counts",
      content: { "application/json": { schema: successEnvelope(z.object({ open: z.number().int(), mineOpen: z.number().int(), unassignedOpen: z.number().int() })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, await getStaffInboxSummary(c.get("db"), staffActor(c).userId));
});

app.openapi(createRoute({
  operationId: "dashboard.conversations.attachment_upload",
  method: "post",
  path: "/attachments",
  tags: ["Admin - Conversations"],
  summary: "Upload one image (JPEG, PNG or WebP, 5 MB or less) for a conversation",
  description: "Multipart form with `file` and either `conversationId` or `orderId`. The image is re-encoded to WebP (metadata removed) and stays private.",
  request: { body: { required: true, ...attachmentUploadRequest } },
  responses: {
    201: { description: "Staged attachment", content: { "application/json": { schema: successEnvelope(attachmentUploadResponseSchema) } } },
    ...writeResponses,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  noStore(c);
  const actor = staffActor(c);
  const db = c.get("db");
  const form = await readAttachmentForm(c);
  const conversationId = formText(form, "conversationId");
  const orderId = formText(form, "orderId");
  const thread = conversationId
    ? await readThread(db, conversationId)
    : orderId ? await getOrCreateOrderThread(db, orderId) : undefined;
  if (!conversationId && !orderId) throw new ValidationError("Say which conversation the image is for.");
  if (!thread) throw new NotFoundError("Conversation not found");
  const image = await readAndReencodeAttachment(c.env, form);
  const staged = await stageConversationAttachment(db, c.env.BUCKET, { conversationId: thread.id, actor, ...image });
  return created(c, { attachmentId: staged.id, ...staged });
});

app.openapi(createRoute({
  operationId: "dashboard.conversations.order_get",
  method: "get",
  path: "/order/{orderId}",
  tags: ["Admin - Conversations"],
  summary: "The order's conversation, or null before anyone wrote",
  request: { params: orderParam, query: beforeSeqQuerySchema },
  responses: {
    200: {
      description: "The order thread",
      content: { "application/json": { schema: successEnvelope(z.object({ conversation: staffConversationThreadSchema.nullable() })) } },
    },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  staffActor(c);
  return ok(c, {
    conversation: await getStaffOrderThread(c.get("db"), c.req.valid("param").orderId, { beforeSeq: c.req.valid("query").beforeSeq }),
  });
});

app.openapi(createRoute({
  operationId: "dashboard.conversations.order_post",
  method: "post",
  path: "/order/{orderId}/messages",
  tags: ["Admin - Conversations"],
  summary: "Reply or add a note on an order's conversation (starts it when needed)",
  request: { params: orderParam, body: { required: true, content: { "application/json": { schema: staffPostBodySchema } } } },
  responses: {
    201: { description: "Posted; the thread after the post", content: { "application/json": { schema: threadEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const actor = staffActor(c);
  const db = c.get("db");
  const body = c.req.valid("json");
  const posted = await postStaffOrderMessage(db, c.req.valid("param").orderId, {
    actor,
    body: body.body,
    visibility: body.visibility,
    clientMessageKey: body.requestKey,
    attachmentIds: body.attachmentIds,
  }, { queue: c.env.JOBS_QUEUE });
  return created(c, { conversation: await getStaffThread(db, posted.conversationId) });
});

app.openapi(createRoute({
  operationId: "dashboard.conversations.get",
  method: "get",
  path: "/{id}",
  tags: ["Admin - Conversations"],
  summary: "One conversation with internal notes, order context and cases",
  request: { params: conversationParam, query: beforeSeqQuerySchema },
  responses: {
    200: { description: "The conversation", content: { "application/json": { schema: threadEnvelope } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  staffActor(c);
  return ok(c, { conversation: await getStaffThread(c.get("db"), c.req.valid("param").id, { beforeSeq: c.req.valid("query").beforeSeq }) });
});

app.openapi(createRoute({
  operationId: "dashboard.conversations.update",
  method: "patch",
  path: "/{id}",
  tags: ["Admin - Conversations"],
  summary: "Change a conversation's status or assignee (guarded by its version)",
  request: {
    params: conversationParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            version: z.number().int().positive(),
            status: z.enum(["open", "pending", "closed"]).optional(),
            assigneeUserId: z.string().min(1).max(128).nullable().optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "The conversation after the change", content: { "application/json": { schema: threadEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  staffActor(c);
  return ok(c, { conversation: await updateStaffThread(c.get("db"), c.req.valid("param").id, c.req.valid("json")) });
});

app.openapi(createRoute({
  operationId: "dashboard.conversations.post",
  method: "post",
  path: "/{id}/messages",
  tags: ["Admin - Conversations"],
  summary: "Reply to the customer or add an internal note",
  request: { params: conversationParam, body: { required: true, content: { "application/json": { schema: staffPostBodySchema } } } },
  responses: {
    201: { description: "Posted; the conversation after the post", content: { "application/json": { schema: threadEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const actor = staffActor(c);
  const db = c.get("db");
  const body = c.req.valid("json");
  const thread = await readThread(db, c.req.valid("param").id);
  if (!thread) throw new NotFoundError("Conversation not found");
  await postConversationMessage(db, thread, {
    actor,
    body: body.body,
    visibility: body.visibility,
    clientMessageKey: body.requestKey,
    attachmentIds: body.attachmentIds,
  }, { queue: c.env.JOBS_QUEUE });
  return created(c, { conversation: await getStaffThread(db, thread.id) });
});

app.openapi(createRoute({
  operationId: "dashboard.conversations.read",
  method: "post",
  path: "/{id}/read",
  tags: ["Admin - Conversations"],
  summary: "Mark a conversation read for staff up to a message",
  request: { params: conversationParam, body: { required: true, content: { "application/json": { schema: readBodySchema } } } },
  responses: {
    200: { description: "Marked", content: { "application/json": { schema: successEnvelope(z.object({ ok: z.literal(true) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  staffActor(c);
  await markStaffRead(c.get("db"), c.req.valid("param").id, c.req.valid("json").seq);
  return ok(c, { ok: true as const });
});

app.openapi(createRoute({
  operationId: "dashboard.conversations.attachment_get",
  method: "get",
  path: "/{id}/attachments/{attachmentId}",
  tags: ["Admin - Conversations"],
  summary: "Read one image of a conversation",
  request: { params: conversationParam.extend({ attachmentId: conversationAttachmentIdSchema }) },
  responses: {
    200: { description: "The re-encoded image", content: { "image/webp": { schema: z.string().openapi({ format: "binary" }) } } },
    ...errorResponses,
  },
}), async (c) => {
  const actor = staffActor(c);
  const { id, attachmentId } = c.req.valid("param");
  const attachment = await resolveConversationAttachment(c.get("db"), { conversationId: id, attachmentId, reader: actor });
  return serveConversationAttachment(c.env, attachment);
});

export { app as adminConversationRoutes };
