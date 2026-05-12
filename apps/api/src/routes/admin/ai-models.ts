import {
  getAllowedWidgetAiModels,
  resolveWidgetAiModelCapabilities,
  type WidgetAiProvider,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import { ServiceUnavailableError } from "../../utils/api-error";

export interface AiModelInfo {
  id: string;
  name: string;
  provider: WidgetAiProvider;
  description?: string | null;
  context_length?: number;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
  structuredOutputMode: "sdk" | "text";
  maxImages: number;
  capabilityNotes?: string[];
  supportsAudio?: boolean;
  modality?: string;
  source?: "api" | "configured" | "fallback";
}

const GEMINI_MODELS_PAGE_SIZE = 1000;
const GEMINI_MODELS_MAX_PAGES = 5;

function jsonHeaders(headers: HeadersInit = {}) {
  return { Accept: "application/json", ...headers };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new ServiceUnavailableError(
      `AI provider request failed: ${response.status} ${body.slice(0, 200)}`,
    );
  }
  return response.json() as Promise<T>;
}

function capabilitiesForModel(
  provider: WidgetAiProvider,
  model: string,
  settings: WidgetAiRuntimeSettings,
) {
  return resolveWidgetAiModelCapabilities(
    provider,
    model,
    settings.providers[provider].capabilities,
  );
}

function withCapabilities(
  model: Omit<
    AiModelInfo,
    "supportsVision" | "supportsStructuredOutput" | "structuredOutputMode" | "maxImages" | "capabilityNotes"
  >,
  settings: WidgetAiRuntimeSettings,
): AiModelInfo {
  const capabilities = capabilitiesForModel(model.provider, model.id, settings);
  return {
    ...model,
    supportsVision: capabilities.supportsVisionInput,
    supportsStructuredOutput: capabilities.supportsStructuredOutput,
    structuredOutputMode: capabilities.structuredOutputMode,
    maxImages: capabilities.maxImages,
    ...(capabilities.notes.length > 0 ? { capabilityNotes: capabilities.notes } : {}),
  };
}

function configuredModel(
  provider: WidgetAiProvider,
  settings: WidgetAiRuntimeSettings,
): AiModelInfo[] {
  const model = settings.providers[provider].defaultModel;
  return model
    ? [
        withCapabilities({
          id: model,
          name: model,
          provider,
          source: "configured",
        }, settings),
      ]
    : [];
}

function configuredModelInfo(
  provider: WidgetAiProvider,
  model: string,
  settings: WidgetAiRuntimeSettings,
): AiModelInfo {
  return withCapabilities({
    id: model,
    name: model,
    provider,
    source: "configured",
  }, settings);
}

function fallbackModels(
  provider: WidgetAiProvider,
  settings: WidgetAiRuntimeSettings,
): AiModelInfo[] {
  const configured = configuredModel(provider, settings);
  const fallbacks: Record<WidgetAiProvider, AiModelInfo[]> = {
    openrouter: [],
    openai: [],
    gemini: [],
    cloudflare: [
      withCapabilities({
        id: "@cf/moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        provider,
        source: "fallback",
      }, settings),
      withCapabilities({
        id: "@cf/openai/gpt-oss-120b",
        name: "GPT OSS 120B",
        provider,
        source: "fallback",
      }, settings),
    ],
  };
  const seen = new Set<string>();
  return [...configured, ...fallbacks[provider]].filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

async function listOpenRouterModels(
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  const provider = "openrouter" as const;
  const baseUrl = settings.providers.openrouter.baseUrl || "https://openrouter.ai/api/v1";
  const data = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
    `${baseUrl.replace(/\/$/, "")}/models`,
    { headers: jsonHeaders() },
  );

  return (data.data ?? []).map((model) => {
    const architecture = model.architecture as
      | { input_modalities?: string[]; output_modalities?: string[]; modality?: string }
      | undefined;
    return withCapabilities({
      id: String(model.id ?? ""),
      name: String(model.name ?? model.id ?? ""),
      provider,
      description:
        typeof model.description === "string" ? model.description : null,
      context_length:
        typeof model.context_length === "number" ? model.context_length : undefined,
      supportsAudio: architecture?.input_modalities?.includes("audio") ?? false,
      modality: architecture?.modality ?? "text->text",
      source: "api" as const,
    }, settings);
  }).filter((model) => model.id);
}

async function listOpenAiModels(
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  const provider = "openai" as const;
  const apiKey = settings.apiKeys.openai;
  if (!apiKey) return fallbackModels(provider, settings);
  const baseUrl = settings.providers.openai.baseUrl || "https://api.openai.com/v1";
  const data = await fetchJson<{ data?: Array<{ id?: string; owned_by?: string }> }>(
    `${baseUrl.replace(/\/$/, "")}/models`,
    { headers: jsonHeaders({ Authorization: `Bearer ${apiKey}` }) },
  );

  return (data.data ?? [])
    .map((model) => {
      const id = model.id ?? "";
      return withCapabilities({
        id,
        name: id,
        provider,
        description: model.owned_by ? `Owned by ${model.owned_by}` : null,
        modality: "text->text",
        source: "api" as const,
      }, settings);
    })
    .filter((model) => model.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildGeminiModelsUrl(baseUrl: string, pageToken?: string): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/models`);
  url.searchParams.set("pageSize", String(GEMINI_MODELS_PAGE_SIZE));
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

async function listGeminiModels(
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  const provider = "gemini" as const;
  const apiKey = settings.apiKeys.gemini;
  if (!apiKey) return fallbackModels(provider, settings);
  const baseUrl =
    settings.providers.gemini.baseUrl ||
    "https://generativelanguage.googleapis.com/v1beta";
  const models: Array<{
    name?: string;
    displayName?: string;
    description?: string;
    inputTokenLimit?: number;
    supportedGenerationMethods?: string[];
  }> = [];
  let pageToken: string | undefined;

  for (let page = 0; page < GEMINI_MODELS_MAX_PAGES; page += 1) {
    const data = await fetchJson<{
      models?: typeof models;
      nextPageToken?: string;
    }>(buildGeminiModelsUrl(baseUrl, pageToken), {
      headers: jsonHeaders({ "x-goog-api-key": apiKey }),
    });
    models.push(...(data.models ?? []));
    pageToken = data.nextPageToken?.trim() || undefined;
    if (!pageToken) break;
  }

  return models
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .map((model) => {
      const id = (model.name ?? "").replace(/^models\//, "");
      return withCapabilities({
        id,
        name: model.displayName || id,
        provider,
        description: model.description ?? null,
        context_length: model.inputTokenLimit,
        modality: "text->text",
        source: "api" as const,
      }, settings);
    })
    .filter((model) => model.id);
}

async function listCloudflareModels(
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  const provider = "cloudflare" as const;
  const accountId = settings.providers.cloudflare.accountId;
  const apiKey = settings.apiKeys.cloudflare;
  if (!accountId || !apiKey) return fallbackModels(provider, settings);

  const data = await fetchJson<{ result?: Array<Record<string, unknown>> }>(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=text-generation`,
    { headers: jsonHeaders({ Authorization: `Bearer ${apiKey}` }) },
  );

  return (data.result ?? [])
    .map((model) => {
      const id = String(model.name ?? model.id ?? "");
      return withCapabilities({
        id,
        name: String(model.display_name ?? model.name ?? id),
        provider,
        description:
          typeof model.description === "string" ? model.description : null,
        modality: "text->text",
        source: "api" as const,
      }, settings);
    })
    .filter((model) => model.id);
}

export async function listModelsForProvider(
  provider: WidgetAiProvider,
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  try {
    if (provider === "openrouter") return await listOpenRouterModels(settings);
    if (provider === "openai") return await listOpenAiModels(settings);
    if (provider === "gemini") return await listGeminiModels(settings);
    return await listCloudflareModels(settings);
  } catch (error) {
    console.warn(`Failed to list ${provider} models:`, error);
    return fallbackModels(provider, settings);
  }
}

export async function listAllowedModelsForProvider(
  provider: WidgetAiProvider,
  settings: WidgetAiRuntimeSettings,
): Promise<AiModelInfo[]> {
  const allowedIds = getAllowedWidgetAiModels(settings, provider);
  if (allowedIds.length === 0) return [];

  const catalog = await listModelsForProvider(provider, settings);
  const byId = new Map(catalog.map((model) => [model.id, model]));

  return allowedIds.map((id) => byId.get(id) ?? configuredModelInfo(provider, id, settings));
}
