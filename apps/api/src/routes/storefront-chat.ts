import { OpenAPIHono } from "@hono/zod-openapi";
import type { ModelMessage } from "ai";
import { resolveAiModelProfile } from "@scalius/core/modules/ai";
import {
  generateAiText,
  loadAiRuntimeSettings,
} from "../modules/ai/model-runtime";
import { ok } from "../utils/api-response";
import {
  STOREFRONT_CHAT_MAX_OUTPUT_TOKENS,
  STOREFRONT_CHAT_SYSTEM_PROMPT,
  enforceStorefrontChatRateLimit,
  isInternalStorefrontChatRequest,
  parseStorefrontChatPayload,
} from "./storefront-chat-contract";
import {
  formatNavigationActionContext,
  formatPageContext,
  formatStorefrontMcpContext,
  normalizeMessages,
} from "./storefront-chat-context";
import {
  collectStorefrontMcpContexts,
  initializeStorefrontAgentMcp,
} from "./storefront-chat-mcp";
import {
  createStorefrontNavigationActions,
  getStorefrontOrigin,
  sanitizeStorefrontAssistantText,
} from "./storefront-chat-navigation";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.post("/chat", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  if (!isInternalStorefrontChatRequest(c.req.raw)) {
    return c.json({ success: false, error: "not_found" }, 404);
  }

  await enforceStorefrontChatRateLimit(c);
  const payload = await parseStorefrontChatPayload(c);
  const settings = await loadAiRuntimeSettings(c);
  const profile = resolveAiModelProfile(settings, "storefrontChat");
  const session = await initializeStorefrontAgentMcp(c);
  const contexts = await collectStorefrontMcpContexts(c, payload, session);
  const origin = getStorefrontOrigin(c.env);
  const actions = createStorefrontNavigationActions(payload, contexts, origin);
  const pageContext = formatPageContext(payload.pageContext);
  const navigationContext = formatNavigationActionContext(actions);
  const messages: ModelMessage[] = [
    { role: "system", content: STOREFRONT_CHAT_SYSTEM_PROMPT },
    { role: "system", content: formatStorefrontMcpContext(contexts) },
    ...(pageContext ? [{ role: "system" as const, content: pageContext }] : []),
    ...(navigationContext
      ? [{ role: "system" as const, content: navigationContext }]
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
      STOREFRONT_CHAT_MAX_OUTPUT_TOKENS,
    ),
    timeoutMs: 20_000,
    maxRetries: 1,
    abortSignal: c.req.raw.signal,
  });
  const assistantText = sanitizeStorefrontAssistantText(result.text, origin);

  return ok(c, {
    profile: "storefrontChat" as const,
    provider: profile.provider,
    model: profile.model,
    message: {
      role: "assistant" as const,
      content: assistantText.text,
    },
    usage: result.usage,
    ...(actions.length > 0 && !assistantText.usedFallback ? { actions } : {}),
  });
});

export { app as storefrontChatRoutes };
