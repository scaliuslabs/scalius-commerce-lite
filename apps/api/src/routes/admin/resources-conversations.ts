// The inbox in the stable app API (operation-registry/README.md), mounted at
// /admin/resources (COMMERCE-HOOKS H18): a helpdesk, CRM or chat app reads
// the store's threads (order, store and chat-channel threads) and their
// lines, staff notes included (`read_conversations`), and replies or adds a
// note (`write_conversations`). The contact's name and address are protected
// customer data: they read null without `read_customer_names` /
// `read_customer_phones`.
//
// A reply is a staff line that names the app (`author: "app"`). It reaches
// the buyer by the thread's own way: email for storefront threads, the chat
// channel for channel threads (sent once through the thread's messaging
// provider after the line commits). `conversations.create_message` takes the
// required Idempotency-Key: a repeat answers the line it first posted.
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { conversationMessages, conversations } from "@scalius/database/schema";
import {
  CONVERSATION_PAGE_MAX,
  conversationMessageRepresentations,
  conversationRepresentations,
  listConversationMessageRows,
  listConversationRows,
  postConversationMessage,
  readChannelContact,
  readConversationRepresentation,
  readThread,
} from "@scalius/core/modules/conversations";
import { keysetCondition } from "@scalius/core/utils/keyset";
import { conversationMessageRepresentationSchema, EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { MESSAGING_CHANNELS } from "@scalius/shared/plugins/providers";
import type { ListCursorShape } from "@scalius/shared/pagination";
import { adminRouter } from "./admin-router";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";
import { requestAppApproverId, requestAppId, requireStaffId } from "./request-actor";
import { conflictResponse, errorResponses, namedSharedSchema, successEnvelope } from "../../schemas/responses";
import { nextCursorSchema } from "../../utils/bounded-page";
import { created, ok } from "../../utils/api-response";
import { AppError, NotFoundError, UnauthorizedError } from "../../utils/api-error";
import { epochSeconds, keysetRowsPage, resourcePageQueryWith, updatedOrder } from "../../utils/resource-page";
import { notificationSender } from "../../background/notification-sender";
import { requestAppProviders } from "../../plugins/providers/app-providers";

const app = adminRouter();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

const TAG = "App API - Inbox";
const ConversationResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.conversation, "ConversationResource");
const ConversationMessageResource = namedSharedSchema(conversationMessageRepresentationSchema, "ConversationMessageResource");
const conversationEnvelope = successEnvelope(z.object({ conversation: ConversationResource }));
const idParam = z.object({ id: z.string().min(1).max(128) });
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };

const LIST_CURSOR: ListCursorShape = { sort: "updatedAt", direction: "asc", kinds: ["number"] };
const LIST_ORDER = updatedOrder(conversations.updatedAt, conversations.id);
const MESSAGE_CURSOR: ListCursorShape = { sort: "seq", direction: "asc", kinds: ["number"] };
const MESSAGE_ORDER = updatedOrder(conversationMessages.seq, conversationMessages.id);

app.openapi(createRoute({
  operationId: "dashboard.resources.conversations.list",
  method: "get",
  path: "/conversations",
  tags: [TAG],
  summary: "List the inbox's threads, least recently updated first",
  description: "Order, store and chat-channel threads (ConversationResource) in (updatedAt, id) order, each with its newest line. `status` narrows to open (waits on the store), pending (waits on the buyer) or closed; `channel` to one chat channel's threads. Start a sync with updatedSince and follow nextCursor; read a thread's lines with conversations.list_messages.",
  request: {
    query: z.object({
      ...resourcePageQueryWith(CONVERSATION_PAGE_MAX, 20),
      status: z.enum(["open", "pending", "closed"]).optional().openapi({ description: "Only threads in this status." }),
      channel: z.enum(MESSAGING_CHANNELS).optional().openapi({ description: "Only this chat channel's threads." }),
    }),
  },
  responses: {
    200: { description: "A page of threads", content: { "application/json": { schema: successEnvelope(z.object({ conversations: z.array(ConversationResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const page = await keysetRowsPage({
    shape: LIST_CURSOR,
    after: (cursor) => keysetCondition(LIST_ORDER, cursor),
    cursor: query.cursor,
    limit: query.limit,
    where: [],
    rows: (after, limit) => listConversationRows(db, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.updatedSince ? { updatedSinceSeconds: epochSeconds(query.updatedSince) } : {}),
      ...(after ? { after } : {}),
      limit,
    }),
    load: (rows) => conversationRepresentations(db, rows),
    position: (conversation) => ({ values: [epochSeconds(conversation.updatedAt)], id: conversation.id }),
  });
  return ok(c, { conversations: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.conversations.get",
  method: "get",
  path: "/conversations/{id}",
  tags: [TAG],
  summary: "Get one thread with its newest line",
  description: "A thread as `conversation.message_received` deliveries carry it: its status, channel and contact (protected customer data), assignee and newest line.",
  request: { params: idParam },
  responses: {
    200: { description: "The thread", content: { "application/json": { schema: conversationEnvelope } } },
    ...readResponses,
  },
}), async (c) => {
  const conversation = await readConversationRepresentation(c.get("db"), c.req.valid("param").id);
  if (!conversation) throw new NotFoundError("Conversation not found");
  return ok(c, { conversation });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.conversations.messages_list",
  method: "get",
  path: "/conversations/{id}/messages",
  tags: [TAG],
  summary: "List a thread's lines, oldest first",
  description: "Every line of the thread in seq order, staff notes (`visibility: internal`) included, with attachments as references and a chat channel's delivery status. Follow nextCursor; a sync keeps the last seq it read.",
  request: { params: idParam, query: z.object(resourcePageQueryWith(CONVERSATION_PAGE_MAX, 50)).omit({ updatedSince: true }) },
  responses: {
    200: { description: "A page of lines", content: { "application/json": { schema: successEnvelope(z.object({ messages: z.array(ConversationMessageResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const query = c.req.valid("query");
  if (!await readThread(db, id)) throw new NotFoundError("Conversation not found");
  const page = await keysetRowsPage({
    shape: MESSAGE_CURSOR,
    after: (cursor) => keysetCondition(MESSAGE_ORDER, cursor),
    cursor: query.cursor,
    limit: query.limit,
    where: [],
    rows: (after, limit) => listConversationMessageRows(db, id, { ...(after ? { after } : {}), limit }),
    load: (rows) => conversationMessageRepresentations(db, rows),
    position: (message) => ({ values: [message.seq], id: message.id }),
  });
  return ok(c, { messages: page.items, nextCursor: page.nextCursor });
});

/** Speaking for the store: the key is required, so a retry after a lost response never posts twice. */
const messageKeyHeaders = z.object({
  "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
    description: "Required: one key posts one line; a repeat with the same body answers it.",
  }),
});

const MessageCreateInput = z.object({
  body: z.string().min(1).max(5000).openapi({ description: "The text. A public reply reaches the buyer by the thread's own way: email for storefront threads, the chat channel for channel threads." }),
  visibility: z.enum(["public", "internal"]).default("public").openapi({ description: "`internal`: a staff note the buyer never sees." }),
}).strict();

/** Who posts: an app (named on the line, standing on its approver) or the signed-in staff member. */
function poster(c: Context): { actor: { kind: "staff"; userId: string }; authorAppId: string | null } {
  const appId = requestAppId(c);
  if (!appId) return { actor: { kind: "staff", userId: requireStaffId(c, "Sign in again to use the inbox.") }, authorAppId: null };
  const approver = requestAppApproverId(c);
  if (!approver) throw new UnauthorizedError("The app's approval could not be read. Approve the app again.");
  return { actor: { kind: "staff", userId: approver }, authorAppId: appId };
}

app.openapi(createRoute({
  operationId: "dashboard.resources.conversations.messages_create",
  method: "post",
  path: "/conversations/{id}/messages",
  tags: [TAG],
  summary: "Reply in a thread or add a staff note",
  description: "Posts one line for the store: a public reply (the thread then waits on the buyer) or an internal note. An app's line names the app. A reply in a chat-channel thread is sent as text through the thread's messaging provider once the line is saved; its `delivery.status` moves from pending to sent (or failed). A thread whose channel has no ready provider refuses a public reply with 422 conversation_channel_unavailable. Requires an Idempotency-Key: a repeat with the same body answers the first line; another body is 409.",
  request: {
    params: idParam,
    headers: messageKeyHeaders,
    body: { required: true, content: { "application/json": { schema: MessageCreateInput } } },
  },
  responses: {
    200: { description: "The line this key already posted", content: { "application/json": { schema: successEnvelope(z.object({ conversation: ConversationResource, message: ConversationMessageResource })) } } },
    201: { description: "The line and the thread after it", content: { "application/json": { schema: successEnvelope(z.object({ conversation: ConversationResource, message: ConversationMessageResource })) } } },
    ...errorResponses,
    409: conflictResponse,
  },
}), async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const thread = await readThread(db, id);
  if (!thread) throw new NotFoundError("Conversation not found");
  const { actor, authorAppId } = poster(c);
  if (thread.channel && body.visibility === "public") {
    // Refused before anything is written: a reply nobody can carry is not a reply.
    const contact = await readChannelContact(db, thread.id);
    const choice = contact ? await requestAppProviders(c).resolve("messaging", contact.providerId) : null;
    if (!choice?.provider) {
      throw new AppError(422, "conversation_channel_unavailable",
        choice?.issue ?? "This chat's messaging app is not available. Add an internal note, or set the app up first.", { conversationId: thread.id });
    }
  }
  const posted = await postConversationMessage(db, thread, {
    actor,
    authorAppId,
    body: body.body,
    visibility: body.visibility,
    clientMessageKey: await scopedRequestKey(c, "dashboard.resources.conversations.messages_create", c.req.valid("header")["idempotency-key"]),
  }, { send: notificationSender(c) });
  const [conversation, line] = await Promise.all([
    readConversationRepresentation(db, thread.id),
    db.select().from(conversationMessages).where(eq(conversationMessages.id, posted.messageId)).get(),
  ]);
  const [message] = await conversationMessageRepresentations(db, line ? [line] : []);
  const answer = { conversation: conversation!, message: message! };
  return posted.created ? created(c, answer) : ok(c, answer);
});

export { app as adminResourceConversationRoutes };
