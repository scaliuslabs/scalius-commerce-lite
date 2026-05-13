import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import {
  decryptCredentials,
  encryptCredentials,
} from "@scalius/core/utils/credential-encryption";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import {
  AI_PROVIDER_IDS,
  DEFAULT_WIDGET_AI_PROVIDER_CAPABILITIES,
  ERROR_MESSAGES,
  GENERATION_CONFIG,
  SYSTEM_PROMPT_FALLBACKS,
  WIDGET_AI_STRUCTURED_OUTPUT_MODES,
  WIDGET_AI_VISION_INPUT_MODES,
  type PromptType,
  type WidgetAiProviderCapabilityConfig,
  type WidgetAiProvider,
  type WidgetAiStructuredOutputMode,
  type WidgetAiVisionInputMode,
} from "./ai-config";
import { AI_PROMPT_TYPES, DEFAULT_AI_PROMPTS } from "./default-prompts";

const AI_SETTINGS_CATEGORY = "ai";
const WIDGET_AI_CONFIG_KEY = "widget_generation_config";

const PROMPT_KEYS: Record<PromptType, string> = {
  widget: "prompt_widget",
  "landing-page": "prompt_landing_page",
  collection: "prompt_collection",
};

const API_KEY_KEYS: Record<WidgetAiProvider, string> = {
  openrouter: "api_key_openrouter",
  openai: "api_key_openai",
  gemini: "api_key_gemini",
  cloudflare: "api_key_cloudflare",
};

const DEFAULT_BASE_URLS: Record<"openrouter" | "openai" | "gemini", string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

const ALLOWED_BASE_URLS: Record<"openrouter" | "openai" | "gemini", string[]> = {
  openrouter: ["https://openrouter.ai/api/v1"],
  openai: ["https://api.openai.com/v1"],
  gemini: ["https://generativelanguage.googleapis.com/v1beta"],
};

export interface WidgetAiProviderConfig {
  enabled: boolean;
  defaultModel: string;
  allowedModels: string[];
  capabilities: WidgetAiProviderCapabilityConfig;
  baseUrl?: string;
  appName?: string;
  appUrl?: string;
  accountId?: string;
}

export interface WidgetAiGenerationConfig {
  activeProvider: WidgetAiProvider;
  providers: Record<WidgetAiProvider, WidgetAiProviderConfig>;
  generation: {
    planningTemperature: number;
    generationTemperature: number;
    improvementTemperature: number;
    fastGenerationMaxOutputTokens: number;
    maxOutputTokens: number;
  };
}

export interface WidgetAiAdminSettings extends WidgetAiGenerationConfig {
  providers: Record<
    WidgetAiProvider,
    WidgetAiProviderConfig & {
      hasApiKey: boolean;
      hasBinding?: boolean;
    }
  >;
  prompts: Record<PromptType, string>;
  defaultPrompts: Record<PromptType, string>;
}

export interface WidgetAiRuntimeSettings extends WidgetAiGenerationConfig {
  apiKeys: Partial<Record<WidgetAiProvider, string>>;
  hasCloudflareBinding: boolean;
}

export interface WidgetAiSettingsUpdate {
  activeProvider?: WidgetAiProvider;
  providers?: Partial<Record<WidgetAiProvider, Partial<WidgetAiProviderConfig>>>;
  generation?: Partial<WidgetAiGenerationConfig["generation"]>;
  prompts?: Partial<Record<PromptType, string>>;
  apiKeys?: Partial<Record<WidgetAiProvider, string>>;
  clearApiKeys?: WidgetAiProvider[];
}

export const DEFAULT_WIDGET_AI_CONFIG: WidgetAiGenerationConfig = {
  activeProvider: "cloudflare",
  providers: {
    openrouter: {
      enabled: false,
      defaultModel: "",
      allowedModels: [],
      capabilities: DEFAULT_WIDGET_AI_PROVIDER_CAPABILITIES.openrouter,
      baseUrl: DEFAULT_BASE_URLS.openrouter,
      appName: "Scalius Commerce",
      appUrl: "",
    },
    openai: {
      enabled: false,
      defaultModel: "",
      allowedModels: [],
      capabilities: DEFAULT_WIDGET_AI_PROVIDER_CAPABILITIES.openai,
      baseUrl: DEFAULT_BASE_URLS.openai,
    },
    gemini: {
      enabled: false,
      defaultModel: "",
      allowedModels: [],
      capabilities: DEFAULT_WIDGET_AI_PROVIDER_CAPABILITIES.gemini,
      baseUrl: DEFAULT_BASE_URLS.gemini,
    },
    cloudflare: {
      enabled: true,
      defaultModel: "@cf/moonshotai/kimi-k2.6",
      allowedModels: [],
      capabilities: DEFAULT_WIDGET_AI_PROVIDER_CAPABILITIES.cloudflare,
      accountId: "",
    },
  },
  generation: {
    planningTemperature: GENERATION_CONFIG.temperature.planning,
    generationTemperature: GENERATION_CONFIG.temperature.generation,
    improvementTemperature: GENERATION_CONFIG.temperature.improvement,
    fastGenerationMaxOutputTokens: 2200,
    maxOutputTokens: 8000,
  },
};

function isProvider(value: unknown): value is WidgetAiProvider {
  return (
    typeof value === "string" &&
    (AI_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

function isPromptType(value: unknown): value is PromptType {
  return (
    typeof value === "string" &&
    (AI_PROMPT_TYPES as readonly string[]).includes(value)
  );
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeModelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const models: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") continue;
    const model = item.trim();
    if (!model || model.length > 200 || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }

  return models.slice(0, 50);
}

function normalizeStructuredOutputMode(value: unknown): WidgetAiStructuredOutputMode {
  return typeof value === "string" &&
    (WIDGET_AI_STRUCTURED_OUTPUT_MODES as readonly string[]).includes(value)
    ? (value as WidgetAiStructuredOutputMode)
    : "auto";
}

function normalizeVisionInputMode(value: unknown): WidgetAiVisionInputMode {
  return typeof value === "string" &&
    (WIDGET_AI_VISION_INPUT_MODES as readonly string[]).includes(value)
    ? (value as WidgetAiVisionInputMode)
    : "auto";
}

function normalizeCapabilityConfig(
  provider: WidgetAiProvider,
  value: unknown,
): WidgetAiProviderCapabilityConfig {
  const defaults = DEFAULT_WIDGET_AI_PROVIDER_CAPABILITIES[provider];
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rawMaxImages = input.maxImages;
  const maxImages =
    typeof rawMaxImages === "number" && Number.isFinite(rawMaxImages)
      ? Math.min(GENERATION_CONFIG.context.maxImages, Math.max(0, Math.round(rawMaxImages)))
      : defaults.maxImages;

  return {
    structuredOutput: normalizeStructuredOutputMode(input.structuredOutput ?? defaults.structuredOutput),
    visionInput: normalizeVisionInputMode(input.visionInput ?? defaults.visionInput),
    ...(typeof maxImages === "number" ? { maxImages } : {}),
  };
}

function normalizeCloudflareAccountId(value: unknown, fallback = ""): string {
  const accountId = asString(value, fallback);
  if (!accountId) return "";
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new ValidationError("Cloudflare account ID must be a 32-character hex string.");
  }
  return accountId.toLowerCase();
}

function normalizeBaseUrl(
  provider: "openrouter" | "openai" | "gemini",
  value: unknown,
): string {
  const fallback = DEFAULT_BASE_URLS[provider];
  const raw = asString(value, fallback) || fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(`Invalid ${provider} base URL.`);
  }

  if (parsed.protocol !== "https:") {
    throw new ValidationError(`Invalid ${provider} base URL. HTTPS is required.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ValidationError(
      `Invalid ${provider} base URL. Credentials, query strings, and fragments are not allowed.`,
    );
  }
  const normalized = parsed.toString().replace(/\/$/, "");
  const allowed = ALLOWED_BASE_URLS[provider].map((url) => url.replace(/\/$/, ""));
  if (!allowed.includes(normalized)) {
    throw new ValidationError(
      `Unsupported ${provider} base URL. Use the official provider endpoint.`,
    );
  }
  return normalized;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeProvider(
  provider: WidgetAiProvider,
  value: unknown,
): WidgetAiProviderConfig {
  const defaults = DEFAULT_WIDGET_AI_CONFIG.providers[provider];
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const normalized: WidgetAiProviderConfig = {
    enabled:
      typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
    defaultModel: asString(input.defaultModel, defaults.defaultModel),
    allowedModels: normalizeModelList(input.allowedModels),
    capabilities: normalizeCapabilityConfig(
      provider,
      input.capabilities ?? defaults.capabilities,
    ),
  };

  if (provider === "openrouter") {
    normalized.baseUrl = normalizeBaseUrl(provider, input.baseUrl ?? defaults.baseUrl);
    normalized.appName = asString(input.appName, defaults.appName);
    normalized.appUrl = asString(input.appUrl, defaults.appUrl);
  }

  if (provider === "openai" || provider === "gemini") {
    normalized.baseUrl = normalizeBaseUrl(provider, input.baseUrl ?? defaults.baseUrl);
  }

  if (provider === "cloudflare") {
    normalized.accountId = normalizeCloudflareAccountId(
      input.accountId,
      defaults.accountId,
    );
  }

  return normalized;
}

export function normalizeWidgetAiConfig(
  value: unknown,
): WidgetAiGenerationConfig {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const rawProviders =
    input.providers && typeof input.providers === "object"
      ? (input.providers as Record<string, unknown>)
      : {};
  const rawGeneration =
    input.generation && typeof input.generation === "object"
      ? (input.generation as Record<string, unknown>)
      : {};

  const providers = Object.fromEntries(
    AI_PROVIDER_IDS.map((provider) => [
      provider,
      normalizeProvider(provider, rawProviders[provider]),
    ]),
  ) as WidgetAiGenerationConfig["providers"];

  const activeProvider = isProvider(input.activeProvider)
    ? input.activeProvider
    : DEFAULT_WIDGET_AI_CONFIG.activeProvider;

  return {
    activeProvider,
    providers,
    generation: {
      planningTemperature: clampNumber(
        rawGeneration.planningTemperature,
        DEFAULT_WIDGET_AI_CONFIG.generation.planningTemperature,
        0,
        2,
      ),
      generationTemperature: clampNumber(
        rawGeneration.generationTemperature,
        DEFAULT_WIDGET_AI_CONFIG.generation.generationTemperature,
        0,
        2,
      ),
      improvementTemperature: clampNumber(
        rawGeneration.improvementTemperature,
        DEFAULT_WIDGET_AI_CONFIG.generation.improvementTemperature,
        0,
        2,
      ),
      fastGenerationMaxOutputTokens: Math.round(
        clampNumber(
          rawGeneration.fastGenerationMaxOutputTokens,
          DEFAULT_WIDGET_AI_CONFIG.generation.fastGenerationMaxOutputTokens,
          512,
          64000,
        ),
      ),
      maxOutputTokens: Math.round(
        clampNumber(
          rawGeneration.maxOutputTokens,
          DEFAULT_WIDGET_AI_CONFIG.generation.maxOutputTokens,
          512,
          64000,
        ),
      ),
    },
  };
}

function mergeWidgetAiConfig(
  current: WidgetAiGenerationConfig,
  update: WidgetAiSettingsUpdate,
): WidgetAiGenerationConfig {
  const providers = Object.fromEntries(
    AI_PROVIDER_IDS.map((provider) => [
      provider,
      normalizeProvider(provider, {
        ...current.providers[provider],
        ...(update.providers?.[provider] ?? {}),
      }),
    ]),
  ) as WidgetAiGenerationConfig["providers"];

  return normalizeWidgetAiConfig({
    activeProvider: update.activeProvider ?? current.activeProvider,
    providers,
    generation: {
      ...current.generation,
      ...(update.generation ?? {}),
    },
  });
}

async function readCategory(db: Database): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.category, AI_SETTINGS_CATEGORY))
    .all();

  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function readApiKeys(
  values: Record<string, string>,
  encryptionKey?: string,
): Promise<Partial<Record<WidgetAiProvider, string>>> {
  if (!encryptionKey) return {};

  const entries = await Promise.all(
    AI_PROVIDER_IDS.map(async (provider) => {
      const stored = values[API_KEY_KEYS[provider]];
      if (!stored) return [provider, undefined] as const;
      try {
        const decrypted = await decryptCredentials(stored, encryptionKey);
        return [provider, decrypted] as const;
      } catch {
        return [provider, undefined] as const;
      }
    }),
  );

  return Object.fromEntries(
    entries.filter(([, value]) => Boolean(value)),
  ) as Partial<Record<WidgetAiProvider, string>>;
}

export async function getWidgetAiPrompts(
  db: Database,
): Promise<Record<PromptType, string>> {
  const values = await readCategory(db);
  return Object.fromEntries(
    AI_PROMPT_TYPES.map((type) => {
      const stored = values[PROMPT_KEYS[type]]?.trim();
      return [type, stored || SYSTEM_PROMPT_FALLBACKS[type]];
    }),
  ) as Record<PromptType, string>;
}

export async function getWidgetAiPrompt(
  db: Database,
  type: string | undefined,
): Promise<string> {
  const promptType = isPromptType(type) ? type : "widget";
  const prompts = await getWidgetAiPrompts(db);
  return prompts[promptType];
}

export async function getWidgetAiRuntimeSettings(
  db: Database,
  env: Record<string, unknown> = {},
  encryptionKey?: string,
): Promise<WidgetAiRuntimeSettings> {
  const values = await readCategory(db);
  const config = normalizeWidgetAiConfig(
    parseJsonObject(values[WIDGET_AI_CONFIG_KEY]),
  );
  const apiKeys = await readApiKeys(values, encryptionKey);

  return {
    ...config,
    apiKeys,
    hasCloudflareBinding: Boolean(env.AI),
  };
}

export function maskWidgetAiAdminSettings(
  runtime: WidgetAiRuntimeSettings,
  prompts: Record<PromptType, string>,
): WidgetAiAdminSettings {
  const { apiKeys, hasCloudflareBinding, ...config } = runtime;
  return {
    ...config,
    providers: Object.fromEntries(
      AI_PROVIDER_IDS.map((provider) => [
        provider,
        {
          ...config.providers[provider],
          hasApiKey: Boolean(apiKeys[provider]),
          ...(provider === "cloudflare"
            ? { hasBinding: hasCloudflareBinding }
            : {}),
        },
      ]),
    ) as WidgetAiAdminSettings["providers"],
    prompts,
    defaultPrompts: DEFAULT_AI_PROMPTS,
  };
}

export async function getWidgetAiAdminSettings(
  db: Database,
  env: Record<string, unknown> = {},
  encryptionKey?: string,
): Promise<WidgetAiAdminSettings> {
  const runtime = await getWidgetAiRuntimeSettings(db, env, encryptionKey);
  const prompts = await getWidgetAiPrompts(db);
  return maskWidgetAiAdminSettings(runtime, prompts);
}

async function deleteSetting(
  db: Database,
  category: string,
  key: string,
): Promise<void> {
  await db
    .delete(settings)
    .where(and(eq(settings.category, category), eq(settings.key, key)));
}

async function upsertPlainSetting(
  db: Database,
  category: string,
  key: string,
  value: string,
  type = "string",
): Promise<void> {
  await db
    .insert(settings)
    .values({
      id: crypto.randomUUID(),
      key,
      value,
      type,
      category,
    })
    .onConflictDoUpdate({
      target: [settings.key, settings.category],
      set: { value, type, updatedAt: sql`unixepoch()` },
    });
}

async function upsertSecretSetting(
  db: Database,
  key: string,
  value: string,
  encryptionKey?: string,
): Promise<void> {
  if (!encryptionKey) {
    throw new ServiceUnavailableError(
      "Credential encryption is not configured. Set CREDENTIAL_ENCRYPTION_KEY before saving AI provider keys.",
    );
  }
  const stored = await encryptCredentials(value, encryptionKey);
  await upsertPlainSetting(db, AI_SETTINGS_CATEGORY, key, stored, "secret");
}

export async function updateWidgetAiSettings(
  db: Database,
  update: WidgetAiSettingsUpdate,
  encryptionKey?: string,
): Promise<void> {
  const values = await readCategory(db);
  const current = normalizeWidgetAiConfig(
    parseJsonObject(values[WIDGET_AI_CONFIG_KEY]),
  );
  const nextConfig = mergeWidgetAiConfig(current, update);

  await upsertPlainSetting(
    db,
    AI_SETTINGS_CATEGORY,
    WIDGET_AI_CONFIG_KEY,
    JSON.stringify(nextConfig),
    "json",
  );

  if (update.prompts) {
    for (const [type, prompt] of Object.entries(update.prompts)) {
      if (!isPromptType(type)) continue;
      const cleaned = prompt.trim();
      await upsertPlainSetting(
        db,
        AI_SETTINGS_CATEGORY,
        PROMPT_KEYS[type],
        cleaned || DEFAULT_AI_PROMPTS[type],
      );
    }
  }

  for (const provider of update.clearApiKeys ?? []) {
    await deleteSetting(db, AI_SETTINGS_CATEGORY, API_KEY_KEYS[provider]);
  }

  if (update.apiKeys) {
    for (const [provider, apiKey] of Object.entries(update.apiKeys)) {
      if (!isProvider(provider)) continue;
      const cleaned = apiKey.trim();
      if (!cleaned) continue;
      await upsertSecretSetting(
        db,
        API_KEY_KEYS[provider],
        cleaned,
        encryptionKey,
      );
    }
  }

  await db
    .update(settings)
    .set({ updatedAt: sql`unixepoch()` })
    .where(
      and(
        eq(settings.category, AI_SETTINGS_CATEGORY),
        eq(settings.key, WIDGET_AI_CONFIG_KEY),
      ),
    );
}

export function getConfiguredProvider(
  settings: WidgetAiRuntimeSettings,
  provider: WidgetAiProvider | undefined,
): WidgetAiProvider {
  const candidate = provider ?? settings.activeProvider;
  if (!settings.providers[candidate]?.enabled) {
    throw new ValidationError(`AI provider "${candidate}" is disabled.`);
  }
  return candidate;
}

export function providerHasCredentials(
  settings: WidgetAiRuntimeSettings,
  provider: WidgetAiProvider,
): boolean {
  if (provider === "cloudflare") {
    return (
      settings.hasCloudflareBinding ||
      Boolean(
        settings.providers.cloudflare.accountId &&
          settings.apiKeys.cloudflare,
      )
    );
  }
  return Boolean(settings.apiKeys[provider]);
}

export function getAllowedWidgetAiModels(
  settings: WidgetAiRuntimeSettings,
  provider: WidgetAiProvider,
): string[] {
  const providerSettings = settings.providers[provider];
  const seen = new Set<string>();
  const models: string[] = [];

  for (const model of [
    providerSettings.defaultModel,
    ...providerSettings.allowedModels,
  ]) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    models.push(trimmed);
  }

  return models;
}

export function requireAllowedWidgetAiModel(
  settings: WidgetAiRuntimeSettings,
  provider: WidgetAiProvider,
  requestedModel: string | undefined,
): string {
  const model =
    requestedModel?.trim() || settings.providers[provider].defaultModel.trim();
  if (!model) throw new ValidationError(ERROR_MESSAGES.modelNotSelected);
  if (model.length > 200) {
    throw new ValidationError("AI model ID is too long.");
  }

  const allowedModels = getAllowedWidgetAiModels(settings, provider);
  if (!allowedModels.includes(model)) {
    throw new ValidationError(
      `AI model "${model}" is not enabled for ${provider}. Add it in General Settings > Widget AI before using it.`,
    );
  }

  return model;
}
