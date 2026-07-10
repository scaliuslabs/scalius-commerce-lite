import { OpenAPIHono } from "@hono/zod-openapi";
import type { ModelMessage } from "ai";
import {
  STOREFRONT_CHAT_API_TIMEOUT_MS,
  STOREFRONT_CHAT_MCP_TIMEOUT_MS,
  STOREFRONT_CHAT_MODEL_TIMEOUT_MS,
} from "@scalius/shared/storefront-chat-boundary";
import { resolveAiModelProfile } from "@scalius/core/modules/ai";
import {
  generateAiText,
  loadAiRuntimeSettings,
} from "../modules/ai/model-runtime";
import { ServiceUnavailableError } from "../utils/api-error";
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
import { buildStorefrontAssistantResponse } from
  "./storefront-chat-parts";
import { classifyStorefrontChatIntent } from "./storefront-chat-intent";
import {
  createStorefrontNavigationActions,
  getStorefrontOrigin,
  sanitizeStorefrontAssistantText,
} from "./storefront-chat-navigation";

const app = new OpenAPIHono<{ Bindings: Env }>();

export function awaitStorefrontChatWork<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new ServiceUnavailableError(
      "Storefront assistant request timed out.",
    ));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new ServiceUnavailableError(
        "Storefront assistant request timed out.",
      ));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createStorefrontChatDeadline(
  parentSignal: AbortSignal,
  timeoutMs = STOREFRONT_CHAT_API_TIMEOUT_MS,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = globalThis.setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      globalThis.clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abort);
    },
  };
}

app.post("/chat", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  if (!isInternalStorefrontChatRequest(c.req.raw)) {
    return c.json({ success: false, error: "not_found" }, 404);
  }

  const deadline = createStorefrontChatDeadline(c.req.raw.signal);
  const requestSignal = deadline.signal;
  try {
  await awaitStorefrontChatWork(
    enforceStorefrontChatRateLimit(c),
    requestSignal,
  );
  const payload = await awaitStorefrontChatWork(
    parseStorefrontChatPayload(c),
    requestSignal,
  );
  const settings = await awaitStorefrontChatWork(
    loadAiRuntimeSettings(c),
    requestSignal,
  );
  const profile = resolveAiModelProfile(settings, "storefrontChat");
  const mcpSignal = AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(STOREFRONT_CHAT_MCP_TIMEOUT_MS),
  ]);
  const intent = classifyStorefrontChatIntent(payload);
  const session = await initializeStorefrontAgentMcp(c, mcpSignal);
  const contexts = await collectStorefrontMcpContexts(
    c,
    payload,
    session,
    intent,
    mcpSignal,
  );
  const origin = getStorefrontOrigin(c.env);
  const actions = createStorefrontNavigationActions(
    payload,
    contexts,
    origin,
    intent,
  );
  const searchQuery = intent.searchQuery;
  let assistantResponse = buildStorefrontAssistantResponse({
    modelText: "",
    contexts,
    payload,
    origin,
    searchQuery,
    intent,
  });
  let usage: Awaited<ReturnType<typeof generateAiText>>["usage"] | null = null;
  let usedModelFallback = false;

  if (!assistantResponse.deterministic) {
    const pageContext = formatPageContext(payload.pageContext);
    const navigationContext = formatNavigationActionContext(actions);
    const messages: ModelMessage[] = [
      { role: "system", content: STOREFRONT_CHAT_SYSTEM_PROMPT },
      { role: "system", content: formatStorefrontMcpContext(contexts) },
      ...(pageContext
        ? [{ role: "system" as const, content: pageContext }]
        : []),
      ...(navigationContext
        ? [{ role: "system" as const, content: navigationContext }]
        : []),
      ...normalizeMessages(payload.messages),
    ];
    try {
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
        timeoutMs: STOREFRONT_CHAT_MODEL_TIMEOUT_MS,
        maxRetries: 1,
        abortSignal: requestSignal,
      });
      usage = result.usage;
      const assistantText = sanitizeStorefrontAssistantText(
        result.text,
        origin,
      );
      usedModelFallback = assistantText.usedFallback;
      assistantResponse = buildStorefrontAssistantResponse({
        modelText: assistantText.text,
        contexts,
        payload,
        origin,
        searchQuery,
        intent,
      });
    } catch (error) {
      if (!assistantResponse.hasCatalogFacts) throw error;
    }
  }
  const hasCatalogParts = assistantResponse.parts.some(
    (part) => part.type === "product_grid" || part.type === "comparison",
  );

  return ok(c, {
    profile: "storefrontChat" as const,
    provider: profile.provider,
    model: profile.model,
    message: {
      role: "assistant" as const,
      content: assistantResponse.text,
      parts: assistantResponse.parts,
    },
    usage,
    ...(actions.length > 0 && (!usedModelFallback || hasCatalogParts)
      ? { actions }
      : {}),
  });
  } finally {
    deadline.dispose();
  }
});

export { app as storefrontChatRoutes };
