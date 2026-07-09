import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ModelMessage } from "ai";
import {
  AI_PROVIDER_IDS,
  resolveAiModelProfile,
} from "@scalius/core/modules/ai";
import {
  generateAiText,
  loadAiRuntimeSettings,
} from "../../modules/ai/model-runtime";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { normalizeMessages } from "./ai-message-normalization";
import {
  ADMIN_CHAT_MAX_OUTPUT_TOKENS,
  ADMIN_CHAT_SYSTEM_PROMPT,
  adminChatPageActionTypeSchema,
  chatSchema,
  validateAdminChatPayload,
  type AdminChatAction,
} from "./ai-chat-contract";
import {
  containsSafeAdminNavigationMarkdownLink,
  createAdminChatNavigationActions,
  createAdminChatPageActions,
  fallbackAdminChatAssistantText,
  formatAdminChatPageActionContext,
  sanitizeAdminChatAssistantText,
} from "./ai-chat-actions";
import {
  formatAdminChatNavigationActionContext,
  formatAdminChatNavigationContext,
  formatAdminChatProductCopyContext,
  getAdminChatNavigationEntries,
  getAdminChatProductCopyContext,
  initializeAdminAgentMcp,
} from "./ai-chat-mcp";
import { enforceAiRateLimit } from "./ai-rate-limit";
import { validateMessagePayload } from "./ai-widget-contract";

const app = new OpenAPIHono<{ Bindings: Env }>();
const providerEnum = z.enum(AI_PROVIDER_IDS);

const chatRoute = createRoute({
  method: "post",
  path: "/chat",
  tags: ["Admin - AI"],
  summary: "Chat with the read-only admin assistant",
  request: {
    body: { content: { "application/json": { schema: chatSchema } } },
  },
  responses: {
    200: {
      description: "Admin chat response",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              profile: z.literal("adminChat"),
              provider: providerEnum,
              model: z.string(),
              message: z.object({
                role: z.literal("assistant"),
                content: z.string(),
              }),
              usage: z
                .object({
                  inputTokens: z.number().optional(),
                  outputTokens: z.number().optional(),
                  totalTokens: z.number().optional(),
                })
                .optional(),
              actions: z
                .array(
                  z.union([
                    z.object({
                      type: z.literal("navigate"),
                      path: z.string(),
                      label: z.string(),
                    }),
                    z.object({
                      type: adminChatPageActionTypeSchema,
                      id: z.string(),
                      targetId: z.string(),
                      label: z.string(),
                      fieldName: z.string().optional(),
                      value: z
                        .union([z.string(), z.number(), z.boolean(), z.null()])
                        .optional(),
                      rowIds: z.array(z.string()).optional(),
                    }),
                  ]),
                )
                .optional(),
            }),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(chatRoute, async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  await enforceAiRateLimit(c);
  const payload = c.req.valid("json");
  validateMessagePayload(payload.messages);
  validateAdminChatPayload(payload.messages);

  const settings = await loadAiRuntimeSettings(c);
  const profile = resolveAiModelProfile(settings, "adminChat");
  const agentSession = await initializeAdminAgentMcp(c);
  const navigationEntries = await getAdminChatNavigationEntries(
    c,
    agentSession,
  );
  const navigationContext = formatAdminChatNavigationContext(navigationEntries);
  const navigationActions = createAdminChatNavigationActions(
    navigationEntries,
    payload.messages,
  );
  const navigationActionContext =
    formatAdminChatNavigationActionContext(navigationActions);
  const pageActionContext = formatAdminChatPageActionContext(
    payload.pageContext,
  );
  const productCopyContext = formatAdminChatProductCopyContext(
    await getAdminChatProductCopyContext(c, agentSession, payload.messages),
  );
  const messages: ModelMessage[] = [
    { role: "system", content: ADMIN_CHAT_SYSTEM_PROMPT },
    ...(navigationContext
      ? [{ role: "system" as const, content: navigationContext }]
      : []),
    ...(navigationActionContext
      ? [{ role: "system" as const, content: navigationActionContext }]
      : []),
    ...(pageActionContext
      ? [{ role: "system" as const, content: pageActionContext }]
      : []),
    ...(productCopyContext
      ? [{ role: "system" as const, content: productCopyContext }]
      : []),
    ...normalizeMessages(payload.messages),
  ];
  const result = await generateAiText({
    provider: profile.provider,
    modelId: profile.model,
    settings,
    env: c.env,
    messages,
    temperature: Math.min(settings.generation.planningTemperature, 0.3),
    maxOutputTokens: Math.min(
      settings.generation.maxOutputTokens,
      ADMIN_CHAT_MAX_OUTPUT_TOKENS,
    ),
    userRoleLabel: "Merchant",
    emptyConversationText: "Continue the admin assistant conversation.",
    abortSignal: c.req.raw.signal,
  });
  const assistantText = sanitizeAdminChatAssistantText(result.text);
  const pageActions = createAdminChatPageActions(
    payload.pageContext,
    payload.messages,
    assistantText.safeForPageActionValue ? assistantText.text : "",
  );
  const actions: AdminChatAction[] = [
    ...navigationActions,
    ...pageActions,
  ].slice(0, 3);
  const useActionFallback =
    actions.length > 0 &&
    containsSafeAdminNavigationMarkdownLink(assistantText.text);
  const messageContent =
    assistantText.usedFallback || useActionFallback
      ? fallbackAdminChatAssistantText(actions)
      : assistantText.text;

  return ok(c, {
    profile: "adminChat" as const,
    provider: profile.provider,
    model: profile.model,
    message: {
      role: "assistant" as const,
      content: messageContent,
    },
    usage: result.usage,
    ...(actions.length > 0 ? { actions } : {}),
  });
});

export { app as adminAiChatRoutes };
