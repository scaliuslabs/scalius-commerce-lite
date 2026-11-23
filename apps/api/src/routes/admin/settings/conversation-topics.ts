// The merchant's conversation topics (Settings → Customer accounts): the
// short list a buyer picks from when they write to the store. Each has a
// label in the store's default language and its labels in the store's other
// languages, edited with the list.
import { createRoute, z } from "@hono/zod-openapi";
import { getConversationTopicsDocument, saveConversationTopics } from "@scalius/core/modules/conversations";
import { CONVERSATION_TOPIC_LIMITS } from "@scalius/shared/conversation";
import { adminRouter } from "../admin-router";
import { ok } from "../../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";

const app = adminRouter();

const topicSchema = z.object({
  key: z.string().trim().min(1).max(CONVERSATION_TOPIC_LIMITS.keyLength).openapi({ description: "Stable id kept on conversations: lowercase letters, digits, - and _." }),
  label: z.string().trim().min(1).max(CONVERSATION_TOPIC_LIMITS.labelLength).openapi({ description: "The name in the store's default language." }),
  labels: z.record(z.string().regex(/^[a-z]{2}$/), z.string().trim().max(CONVERSATION_TOPIC_LIMITS.labelLength)).optional()
    .openapi({ description: "The name in the store's other languages, by two-letter code. A language with none reads `label`." }),
}).strict();

// `messageTopics`, not `topics`: an approval names a field by its key, and `topics` is a webhook's events.
const payloadSchema = z.object({
  messageTopics: z.array(topicSchema).max(CONVERSATION_TOPIC_LIMITS.topics),
  revision: z.number().int().nonnegative(),
});

app.openapi(createRoute({
  method: "get",
  path: "/conversation-topics",
  operationId: "dashboard.conversation_topics.get",
  tags: ["Admin - Settings"],
  summary: "Get the topics buyers choose from when they write to the store",
  responses: {
    200: { description: "The topics and their revision", content: { "application/json": { schema: successEnvelope(payloadSchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  const { topics, revision } = await getConversationTopicsDocument(c.get("db"));
  return ok(c, { messageTopics: topics, revision });
});

app.openapi(createRoute({
  method: "put",
  path: "/conversation-topics",
  operationId: "dashboard.conversation_topics.update",
  tags: ["Admin - Settings"],
  summary: "Replace the topics buyers choose from (at most 12)",
  description: "A conversation keeps its topic's key: a renamed topic reads its new name, a removed one reads no name (and its names in every language go with it). An invalid list is a 400 whose `details.reason` is `too_many`, `invalid_key`, `duplicate_key` or `invalid_label` (with `details.index`).",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            messageTopics: z.array(topicSchema).max(CONVERSATION_TOPIC_LIMITS.topics),
            expectedRevision: z.number().int().nonnegative(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "The saved topics", content: { "application/json": { schema: successEnvelope(payloadSchema) } } },
    ...errorResponses,
    409: conflictResponse,
  },
}), async (c) => {
  const { messageTopics, expectedRevision } = c.req.valid("json");
  const saved = await saveConversationTopics(c.get("db"), messageTopics, { expectedRevision });
  return ok(c, { messageTopics: saved.topics, revision: saved.revision });
});

export { app as conversationTopicRoutes };
