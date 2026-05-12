import type { ModelMessage } from "ai";

type ProviderOptions = Record<string, Record<string, unknown>>;

type AiCacheControl = {
  type: "ephemeral";
  ttl?: "5m" | "1h";
};

export interface AiMessagePart {
  type: string;
  text?: string;
  image_url?: { url: string };
  image?: string;
  mediaType?: string;
  cache_control?: unknown;
  providerOptions?: ProviderOptions;
}

export interface AiMessagePayload {
  role: "system" | "user" | "assistant";
  content: string | AiMessagePart[];
}

type AiUserPart =
  | { type: "text"; text: string; providerOptions?: ProviderOptions }
  | { type: "image"; image: URL; mediaType?: string; providerOptions?: ProviderOptions };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeCacheControl(value: unknown): AiCacheControl | undefined {
  if (!isRecord(value) || value.type !== "ephemeral") return undefined;
  const ttl = value.ttl;
  if (ttl !== undefined && ttl !== "5m" && ttl !== "1h") return undefined;
  return ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" };
}

function readProviderOptions(value: unknown): ProviderOptions | undefined {
  return isRecord(value) ? (value as ProviderOptions) : undefined;
}

function withCacheControlProviderOptions(
  existing: ProviderOptions | undefined,
  cacheControl: AiCacheControl | undefined,
): ProviderOptions | undefined {
  if (!cacheControl) return existing;

  return {
    ...(existing ?? {}),
    openrouter: {
      ...(isRecord(existing?.openrouter) ? existing.openrouter : {}),
      cacheControl,
    },
    anthropic: {
      ...(isRecord(existing?.anthropic) ? existing.anthropic : {}),
      cacheControl,
    },
  };
}

function providerOptionsForPart(part: AiMessagePart): ProviderOptions | undefined {
  return withCacheControlProviderOptions(
    readProviderOptions(part.providerOptions),
    normalizeCacheControl(part.cache_control),
  );
}

function contentPartToText(part: unknown): string {
  if (!isRecord(part)) return "";
  if (typeof part.text === "string") return part.text;
  if (
    isRecord(part.image_url) &&
    typeof part.image_url.url === "string"
  ) {
    return `[Image: ${part.image_url.url}]`;
  }
  if (typeof part.image === "string") return `[Image: ${part.image}]`;
  return "";
}

function normalizeContentParts(parts: AiMessagePart[]): AiUserPart[] {
  return parts
    .map((part) => {
      const providerOptions = providerOptionsForPart(part);
      if (part.type === "text" && typeof part.text === "string") {
        return {
          type: "text" as const,
          text: part.text,
          ...(providerOptions ? { providerOptions } : {}),
        };
      }

      const imageUrl =
        part.type === "image_url" &&
        part.image_url &&
        typeof part.image_url.url === "string"
          ? part.image_url.url
          : part.type === "image" && typeof part.image === "string"
            ? part.image
            : "";

      if (imageUrl) {
        try {
          return {
            type: "image" as const,
            image: new URL(imageUrl),
            ...(part.mediaType ? { mediaType: part.mediaType } : {}),
            ...(providerOptions ? { providerOptions } : {}),
          };
        } catch {
          return {
            type: "text" as const,
            text: `[Image: ${imageUrl}]`,
            ...(providerOptions ? { providerOptions } : {}),
          };
        }
      }

      const text = contentPartToText(part);
      return text
        ? {
            type: "text" as const,
            text,
            ...(providerOptions ? { providerOptions } : {}),
          }
        : null;
    })
    .filter(Boolean) as AiUserPart[];
}

function mergedProviderOptionsFromParts(parts: AiMessagePart[]): ProviderOptions | undefined {
  return parts.reduce<ProviderOptions | undefined>((merged, part) => {
    const partOptions = providerOptionsForPart(part);
    if (!partOptions) return merged;
    return {
      ...(merged ?? {}),
      ...partOptions,
      openrouter: {
        ...(isRecord(merged?.openrouter) ? merged.openrouter : {}),
        ...(isRecord(partOptions.openrouter) ? partOptions.openrouter : {}),
      },
      anthropic: {
        ...(isRecord(merged?.anthropic) ? merged.anthropic : {}),
        ...(isRecord(partOptions.anthropic) ? partOptions.anthropic : {}),
      },
    };
  }, undefined);
}

export function normalizeMessages(messages: AiMessagePayload[]): ModelMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content } as ModelMessage;
    }

    if (message.role === "user") {
      return {
        role: "user",
        content: normalizeContentParts(message.content),
      } as ModelMessage;
    }

    const providerOptions = mergedProviderOptionsFromParts(message.content);
    return {
      role: message.role,
      content: message.content.map(contentPartToText).filter(Boolean).join("\n"),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  });
}
