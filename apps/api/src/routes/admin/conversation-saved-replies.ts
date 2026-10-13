import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import {
  createSavedReply,
  getSavedReply,
  listSavedReplies,
  updateSavedReply,
} from "@scalius/core/modules/conversations";
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import { UnauthorizedError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";

const app = new OpenAPIHono<{ Bindings: Env }>();
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const modeSchema = z.enum(["reply", "note"]);
const paramsSchema = z.object({ replyId: idSchema });
// Raw UTF-16 bounds allow the core normalizer to enforce Unicode character
// limits consistently with messages, including composed text and emoji.
const titleSchema = z.string().max(160).openapi({ description: "A one-line title, 1–80 characters after normalization." });
const bodySchema = z.string().max(CONVERSATION_LIMITS.bodyLength * 2).openapi({ description: "Plain text, 1–5,000 characters after normalization." });
const savedReplySchema = z.object({
  id: idSchema,
  title: z.string(),
  body: z.string(),
  mode: modeSchema,
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  archivedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  version: z.number().int().positive(),
});
const rowResponse = {
  description: "Saved reply, including its current version and archive state",
  content: { "application/json": { schema: successEnvelope(savedReplySchema) } },
};

function staffId(c: Context<{ Bindings: Env }>): string {
  const user = c.get("user") as { id?: string } | undefined;
  if (!user?.id) throw new UnauthorizedError("Sign in again to use saved replies.");
  return user.id;
}

const privateStaffRoute: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  staffId(c);
  await next();
};
app.use("/saved-replies", privateStaffRoute);
app.use("/saved-replies/*", privateStaffRoute);

app.openapi(createRoute({
  operationId: "dashboard.conversations.saved_replies.list",
  method: "get",
  path: "/saved-replies",
  tags: ["Admin - Conversations"],
  summary: "List active saved replies, 50 per page",
  request: { query: z.object({
    mode: modeSchema.optional(),
    q: z.string().max(100).optional().openapi({ description: "Search saved reply titles only." }),
    cursor: z.string().max(1024).optional(),
  }) },
  responses: {
    200: {
      description: "Active saved replies, newest edits first",
      content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(savedReplySchema), nextCursor: z.string().nullable() })) } },
    },
    ...errorResponses,
  },
}), async (c) => ok(c, await listSavedReplies(c.get("db"), c.req.valid("query"))));

app.openapi(createRoute({
  operationId: "dashboard.conversations.saved_replies.create",
  method: "post",
  path: "/saved-replies",
  tags: ["Admin - Conversations"],
  summary: "Create a saved reply, or return an identical retry",
  description: "Generate a fresh id before creating. Reusing an id is accepted only for the same creator and normalized content. Creation never sends a message.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({
    id: idSchema,
    title: titleSchema,
    body: bodySchema,
    mode: modeSchema,
  }).strict() } } } },
  responses: { 200: rowResponse, ...errorResponses, 409: conflictResponse },
}), async (c) => ok(c, await createSavedReply(c.get("db"), staffId(c), c.req.valid("json"))));

app.openapi(createRoute({
  operationId: "dashboard.conversations.saved_replies.get",
  method: "get",
  path: "/saved-replies/{replyId}",
  tags: ["Admin - Conversations"],
  summary: "Read a saved reply's current content and archive state",
  description: "An archived reply stays readable by id so a composer can refuse a stale selection.",
  request: { params: paramsSchema },
  responses: { 200: rowResponse, ...errorResponses },
}), async (c) => ok(c, await getSavedReply(c.get("db"), c.req.valid("param").replyId)));

app.openapi(createRoute({
  operationId: "dashboard.conversations.saved_replies.update",
  method: "patch",
  path: "/saved-replies/{replyId}",
  tags: ["Admin - Conversations"],
  summary: "Edit, archive or restore a saved reply using its current version",
  request: {
    params: paramsSchema,
    body: { required: true, content: { "application/json": { schema: z.object({
      version: z.number().int().positive(),
      title: titleSchema.optional(),
      body: bodySchema.optional(),
      archived: z.boolean().optional(),
    }).strict() } } },
  },
  responses: { 200: rowResponse, ...errorResponses, 409: conflictResponse },
}), async (c) => ok(c, await updateSavedReply(c.get("db"), staffId(c), c.req.valid("param").replyId, c.req.valid("json"))));

export { app as adminConversationSavedReplyRoutes };
