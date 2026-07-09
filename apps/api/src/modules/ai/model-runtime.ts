import type { Context } from "hono";
import type { LanguageModel, ModelMessage } from "ai";
import {
  ERROR_MESSAGES,
  getTimeout,
  getWidgetAiRuntimeSettings,
  providerHasCredentials,
  type WidgetAiProvider,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import {
  ServiceUnavailableError,
  ValidationError,
} from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";

export type AiGenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type AiTextGenerationResult = {
  text: string;
  usage: AiGenerationUsage;
};

type ApiContext = Context<{ Bindings: Env }>;

export async function loadAiRuntimeSettings(
  c: ApiContext,
): Promise<WidgetAiRuntimeSettings> {
  return getWidgetAiRuntimeSettings(
    c.get("db"),
    c.env,
    getCredentialEncryptionKey(c.env),
  );
}

/**
 * The only API-layer adapter from saved AI profiles to provider SDKs.
 * Provider clients remain lazy so routes that do not generate never load them.
 */
export async function createAiLanguageModel(
  provider: WidgetAiProvider,
  modelId: string,
  settings: WidgetAiRuntimeSettings,
  env: Env,
): Promise<LanguageModel> {
  if (!providerHasCredentials(settings, provider)) {
    throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
  }

  switch (provider) {
    case "openrouter": {
      const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
      const client = createOpenRouter({
        apiKey: settings.apiKeys.openrouter,
        baseURL: settings.providers.openrouter.baseUrl,
        appName: settings.providers.openrouter.appName || undefined,
        appUrl: settings.providers.openrouter.appUrl || undefined,
        compatibility: "strict",
      });
      return client(modelId);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const client = createOpenAI({
        apiKey: settings.apiKeys.openai,
        baseURL: settings.providers.openai.baseUrl,
      });
      return client(modelId);
    }
    case "gemini": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const client = createGoogleGenerativeAI({
        apiKey: settings.apiKeys.gemini,
        baseURL: settings.providers.gemini.baseUrl,
      });
      return client(modelId);
    }
    case "cloudflare": {
      const { createWorkersAI } = await import("workers-ai-provider");
      if (env.AI) {
        return createWorkersAI({ binding: env.AI as Ai })(modelId);
      }

      const accountId = settings.providers.cloudflare.accountId;
      const apiKey = settings.apiKeys.cloudflare;
      if (!accountId || !apiKey) {
        throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
      }
      return createWorkersAI({ accountId, apiKey })(modelId);
    }
  }
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isCloudflareGeminiModel(modelId: string): boolean {
  return /^google\/gemini-/i.test(modelId.trim());
}

function buildCloudflareGeminiInput(
  messages: ModelMessage[],
  options: {
    temperature: number;
    maxOutputTokens: number;
    userRoleLabel?: string;
    emptyConversationText?: string;
  },
): Record<string, unknown> {
  const systemInstruction = messages
    .filter((message) => message.role === "system")
    .map((message) => messageContentText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const conversationText = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const role =
        message.role === "assistant"
          ? "Assistant"
          : (options.userRoleLabel ?? "User");
      const text = messageContentText(message.content);
      return text ? `${role}:\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              conversationText ||
              options.emptyConversationText ||
              "Continue the conversation.",
          },
        ],
      },
    ],
    generationConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
    },
    ...(systemInstruction
      ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
      : {}),
  };
}

function readCloudflareGeminiText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const candidates = (response as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return "";

  return candidates
    .flatMap((candidate) => {
      const parts = (candidate as { content?: { parts?: unknown } })?.content
        ?.parts;
      if (!Array.isArray(parts)) return [];
      return parts
        .map((part) =>
          part && typeof part === "object"
            ? (part as { text?: unknown }).text
            : undefined,
        )
        .filter(
          (text): text is string =>
            typeof text === "string" && text.trim().length > 0,
        );
    })
    .join("\n")
    .trim();
}

function usageFromCloudflareGemini(response: unknown): AiGenerationUsage {
  const usage =
    response && typeof response === "object"
      ? (response as { usageMetadata?: Record<string, unknown> }).usageMetadata
      : undefined;
  return {
    inputTokens:
      typeof usage?.promptTokenCount === "number"
        ? usage.promptTokenCount
        : undefined,
    outputTokens:
      typeof usage?.candidatesTokenCount === "number"
        ? usage.candidatesTokenCount
        : undefined,
    totalTokens:
      typeof usage?.totalTokenCount === "number"
        ? usage.totalTokenCount
        : undefined,
  };
}

function safeProviderErrorDetail(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const sanitized = raw
    .replace(
      /\b(?:Bearer|token|secret|key)\s+[A-Za-z0-9._~+/-]+=*/gi,
      "[redacted-token]",
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-token]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, 240) : null;
}

function usageFromAiSdk(result: {
  totalUsage?: AiGenerationUsage;
}): AiGenerationUsage {
  return {
    inputTokens: result.totalUsage?.inputTokens,
    outputTokens: result.totalUsage?.outputTokens,
    totalTokens: result.totalUsage?.totalTokens,
  };
}

export async function generateAiText(options: {
  provider: WidgetAiProvider;
  modelId: string;
  settings: WidgetAiRuntimeSettings;
  env: Env;
  messages: ModelMessage[];
  temperature: number;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  userRoleLabel?: string;
  emptyConversationText?: string;
}): Promise<AiTextGenerationResult> {
  if (
    options.provider === "cloudflare" &&
    options.env.AI &&
    isCloudflareGeminiModel(options.modelId)
  ) {
    try {
      const response = await (options.env.AI as Ai).run(
        options.modelId as never,
        buildCloudflareGeminiInput(options.messages, options) as never,
      );
      const text = readCloudflareGeminiText(response);
      if (!text) {
        throw new ServiceUnavailableError(
          `Cloudflare AI model "${options.modelId}" did not return a readable text response.`,
        );
      }
      return { text, usage: usageFromCloudflareGemini(response) };
    } catch (error) {
      if (error instanceof ServiceUnavailableError) throw error;
      const detail = safeProviderErrorDetail(error);
      throw new ServiceUnavailableError(
        `Cloudflare AI model "${options.modelId}" failed.${detail ? ` ${detail}` : ""}`,
      );
    }
  }

  const model = await createAiLanguageModel(
    options.provider,
    options.modelId,
    options.settings,
    options.env,
  );
  const { generateText } = await import("ai");
  const result = await generateText({
    model,
    messages: options.messages,
    allowSystemInMessages: true,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    timeout: { totalMs: options.timeoutMs ?? getTimeout("planning") },
    maxRetries: options.maxRetries ?? 1,
    abortSignal: options.abortSignal,
  });

  return {
    text: result.text.trim(),
    usage: usageFromAiSdk(result),
  };
}
