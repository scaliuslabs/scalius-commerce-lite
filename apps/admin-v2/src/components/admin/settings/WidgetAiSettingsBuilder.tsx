import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useSettingsForm } from "~/hooks/use-settings-form";
import {
  getWidgetAiSettings,
  updateWidgetAiSettings,
  type UpdateWidgetAiSettingsInput,
} from "~/lib/api-functions/settings";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "@scalius/shared/utils";
import {
  DEFAULT_IMAGE_GENERATION_MODELS,
  isImageGenerationModel,
  isImageGenerationProvider,
  normalizeCloudflareAiModelId,
} from "@scalius/core/modules/ai/ai-config";
import { CheckCircle2, KeyRound, Loader2, RotateCcw, Save, Trash2 } from "lucide-react";

type ProviderId = "openrouter" | "openai" | "gemini" | "cloudflare";
type PromptId = "widget" | "landing-page" | "collection";
type ProfileId =
  | "adminChat"
  | "storefrontChat"
  | "widgetGeneration"
  | "imageGeneration"
  | "voice";
type StructuredOutputMode = "auto" | "sdk" | "text";
type VisionInputMode = "auto" | "enabled" | "disabled";

interface ProviderCapabilityValues {
  structuredOutput: StructuredOutputMode;
  visionInput: VisionInputMode;
  maxImages: number;
}

interface ProviderValues {
  enabled: boolean;
  defaultModel: string;
  allowedModels: string[];
  capabilities: ProviderCapabilityValues;
  baseUrl: string;
  appName: string;
  appUrl: string;
  accountId: string;
  hasApiKey: boolean;
  hasBinding: boolean;
  apiKeyInput: string;
  clearApiKey: boolean;
}

interface ModelProfileValues {
  enabled: boolean;
  provider: ProviderId;
  model: string;
}

export interface WidgetAiValues {
  activeProvider: ProviderId;
  providers: Record<ProviderId, ProviderValues>;
  profiles: Record<ProfileId, ModelProfileValues>;
  generation: {
    planningTemperature: number;
    generationTemperature: number;
    improvementTemperature: number;
    fastGenerationMaxOutputTokens: number;
    maxOutputTokens: number;
  };
  prompts: Record<PromptId, string>;
  defaultPrompts: Record<PromptId, string>;
}

const PROVIDERS: Array<{ id: ProviderId; label: string; hint: string }> = [
  { id: "openrouter", label: "OpenRouter", hint: "Multi-provider router" },
  { id: "openai", label: "OpenAI", hint: "Direct OpenAI API" },
  { id: "gemini", label: "Gemini", hint: "Google Generative AI" },
  { id: "cloudflare", label: "Cloudflare", hint: "Workers AI binding or model-catalog API token" },
];

const PROMPTS: Array<{ id: PromptId; label: string }> = [
  { id: "widget", label: "Homepage Widget" },
  { id: "landing-page", label: "Landing Page" },
  { id: "collection", label: "Collection Page" },
];

export const PROFILE_DEFINITIONS: Array<{
  id: ProfileId;
  label: string;
  badge: string;
  description: string;
}> = [
  {
    id: "adminChat",
    label: "Admin chat",
    badge: "Available now",
    description: "Powers the dashboard assistant bubble with safe page context and click-confirmed navigation.",
  },
  {
    id: "storefrontChat",
    label: "Storefront chat",
    badge: "Prerequisite only",
    description: "For future buyer-facing assistant sessions.",
  },
  {
    id: "widgetGeneration",
    label: "Widget generation",
    badge: "Current tools",
    description: "Keeps the existing widget generator model explicit.",
  },
  {
    id: "imageGeneration",
    label: "Image generation",
    badge: "Available now",
    description: "Generates bounded previews in the media library and saves verified provenance only after confirmation.",
  },
  {
    id: "voice",
    label: "Voice",
    badge: "Prerequisite only",
    description: "For future voice input and response workflows.",
  },
];

const STRUCTURED_OUTPUT_OPTIONS: Array<{ value: StructuredOutputMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "sdk", label: "Force SDK schema" },
  { value: "text", label: "Text tags" },
];

const VISION_INPUT_OPTIONS: Array<{ value: VisionInputMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "enabled", label: "Force on" },
  { value: "disabled", label: "Off" },
];

const defaultProviderValues: ProviderValues = {
  enabled: false,
  defaultModel: "",
  allowedModels: [],
  capabilities: {
    structuredOutput: "auto",
    visionInput: "auto",
    maxImages: 10,
  },
  baseUrl: "",
  appName: "",
  appUrl: "",
  accountId: "",
  hasApiKey: false,
  hasBinding: false,
  apiKeyInput: "",
  clearApiKey: false,
};

const defaultValues: WidgetAiValues = {
  activeProvider: "cloudflare",
  providers: {
    openrouter: {
      ...defaultProviderValues,
      baseUrl: "https://openrouter.ai/api/v1",
      appName: "Scalius Commerce",
    },
    openai: {
      ...defaultProviderValues,
      baseUrl: "https://api.openai.com/v1",
    },
    gemini: {
      ...defaultProviderValues,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    },
    cloudflare: {
      ...defaultProviderValues,
      enabled: true,
      defaultModel: "@cf/moonshotai/kimi-k2.6",
    },
  },
  profiles: {
    adminChat: {
      enabled: false,
      provider: "cloudflare",
      model: "",
    },
    storefrontChat: {
      enabled: false,
      provider: "cloudflare",
      model: "",
    },
    widgetGeneration: {
      enabled: true,
      provider: "cloudflare",
      model: "@cf/moonshotai/kimi-k2.6",
    },
    imageGeneration: {
      enabled: false,
      provider: "cloudflare",
      model: "",
    },
    voice: {
      enabled: false,
      provider: "cloudflare",
      model: "",
    },
  },
  generation: {
    planningTemperature: 0.3,
    generationTemperature: 0.7,
    improvementTemperature: 0.6,
    fastGenerationMaxOutputTokens: 2200,
    maxOutputTokens: 8000,
  },
  prompts: {
    widget: "",
    "landing-page": "",
    collection: "",
  },
  defaultPrompts: {
    widget: "",
    "landing-page": "",
    collection: "",
  },
};

function normalizeModelIdForProvider(
  provider: ProviderId,
  value: unknown,
): string {
  const model = normalizeModelId(value);
  return provider === "cloudflare"
    ? normalizeCloudflareAiModelId(model)
    : model;
}

function normalizeAllowedModels(
  value: unknown,
  provider?: ProviderId,
): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    const model =
      provider === "cloudflare"
        ? normalizeCloudflareAiModelId(trimmed)
        : trimmed;
    if (!model || model.length > 200 || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }

  return models.slice(0, 50);
}

function normalizeModelId(value: unknown): string {
  if (typeof value !== "string") return "";
  const model = value.trim();
  return model.length > 200 ? model.slice(0, 200) : model;
}

function normalizeStructuredOutputMode(value: unknown): StructuredOutputMode {
  return value === "sdk" || value === "text" || value === "auto" ? value : "auto";
}

function normalizeVisionInputMode(value: unknown): VisionInputMode {
  return value === "enabled" || value === "disabled" || value === "auto" ? value : "auto";
}

function normalizeMaxImages(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return 10;
  return Math.min(10, Math.max(0, Math.round(numberValue)));
}

function normalizeCapabilities(value: unknown): ProviderCapabilityValues {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<ProviderCapabilityValues>)
      : {};

  return {
    structuredOutput: normalizeStructuredOutputMode(data.structuredOutput),
    visionInput: normalizeVisionInputMode(data.visionInput),
    maxImages: normalizeMaxImages(data.maxImages),
  };
}

function parseAllowedModelsText(
  value: string,
  provider?: ProviderId,
): string[] {
  return normalizeAllowedModels(value.split(/\r?\n|,/), provider);
}

function normalizeProvider(id: ProviderId, value: unknown): ProviderValues {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<ProviderValues>)
      : {};
  return {
    ...defaultValues.providers[id],
    enabled: typeof data.enabled === "boolean" ? data.enabled : defaultValues.providers[id].enabled,
    defaultModel: normalizeModelIdForProvider(
      id,
      typeof data.defaultModel === "string"
        ? data.defaultModel
        : defaultValues.providers[id].defaultModel,
    ),
    allowedModels: normalizeAllowedModels(data.allowedModels, id),
    capabilities: normalizeCapabilities(data.capabilities),
    baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : defaultValues.providers[id].baseUrl,
    appName: typeof data.appName === "string" ? data.appName : defaultValues.providers[id].appName,
    appUrl: typeof data.appUrl === "string" ? data.appUrl : defaultValues.providers[id].appUrl,
    accountId: typeof data.accountId === "string" ? data.accountId : defaultValues.providers[id].accountId,
    hasApiKey: Boolean(data.hasApiKey),
    hasBinding: Boolean(data.hasBinding),
    apiKeyInput: "",
    clearApiKey: false,
  };
}

function normalizeProviderId(
  value: unknown,
  fallback: ProviderId = defaultValues.activeProvider,
): ProviderId {
  return PROVIDERS.some((provider) => provider.id === value)
    ? (value as ProviderId)
    : fallback;
}

function getProviderModelOptions(
  providers: Record<ProviderId, ProviderValues>,
  provider: ProviderId,
): string[] {
  return normalizeAllowedModels([
    providers[provider].defaultModel,
    ...providers[provider].allowedModels,
  ], provider);
}

function getProfileModelOptions(
  profile: ProfileId,
  providers: Record<ProviderId, ProviderValues>,
  provider: ProviderId,
): string[] {
  if (profile !== "imageGeneration") {
    return getProviderModelOptions(providers, provider);
  }
  if (!isImageGenerationProvider(provider)) return [];
  return normalizeAllowedModels([
    DEFAULT_IMAGE_GENERATION_MODELS[provider],
    ...getProviderModelOptions(providers, provider),
  ], provider).filter((model) => isImageGenerationModel(provider, model));
}

function getDefaultProfile(
  id: ProfileId,
  activeProvider: ProviderId,
  providers: Record<ProviderId, ProviderValues>,
): ModelProfileValues {
  const provider = activeProvider;
  const futureProfileModel = defaultValues.profiles[id].model;
  return {
    enabled: id === "widgetGeneration",
    provider,
    model:
      id === "widgetGeneration"
        ? providers[provider]?.defaultModel || defaultValues.providers[provider].defaultModel
        : futureProfileModel,
  };
}

function normalizeProfile(
  id: ProfileId,
  value: unknown,
  activeProvider: ProviderId,
  providers: Record<ProviderId, ProviderValues>,
): ModelProfileValues {
  const fallback = getDefaultProfile(id, activeProvider, providers);
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<ModelProfileValues>)
      : {};
  const provider = normalizeProviderId(data.provider, fallback.provider);
  const savedModel = normalizeModelIdForProvider(provider, data.model);
  const model =
    savedModel ||
    (id === "widgetGeneration"
      ? providers[provider]?.defaultModel || fallback.model
      : fallback.model);

  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : fallback.enabled,
    provider,
    model,
  };
}

function normalizeProfiles(
  value: unknown,
  activeProvider: ProviderId,
  providers: Record<ProviderId, ProviderValues>,
): WidgetAiValues["profiles"] {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return Object.fromEntries(
    PROFILE_DEFINITIONS.map((profile) => [
      profile.id,
      normalizeProfile(profile.id, data[profile.id], activeProvider, providers),
    ]),
  ) as WidgetAiValues["profiles"];
}

export function normalizeWidgetAiSettingsData(data: Record<string, unknown>): WidgetAiValues {
  const providers = (data.providers ?? {}) as Record<string, unknown>;
  const prompts = (data.prompts ?? {}) as Partial<Record<PromptId, string>>;
  const defaultPrompts = (data.defaultPrompts ?? {}) as Partial<Record<PromptId, string>>;
  const generation = (data.generation ?? {}) as Partial<WidgetAiValues["generation"]>;
  const activeProvider = normalizeProviderId(data.activeProvider);
  const normalizedProviders = {
    openrouter: normalizeProvider("openrouter", providers.openrouter),
    openai: normalizeProvider("openai", providers.openai),
    gemini: normalizeProvider("gemini", providers.gemini),
    cloudflare: normalizeProvider("cloudflare", providers.cloudflare),
  };

  return {
    activeProvider,
    providers: normalizedProviders,
    profiles: normalizeProfiles(data.profiles, activeProvider, normalizedProviders),
    generation: {
      planningTemperature: Number(generation.planningTemperature ?? 0.3),
      generationTemperature: Number(generation.generationTemperature ?? 0.7),
      improvementTemperature: Number(generation.improvementTemperature ?? 0.6),
      fastGenerationMaxOutputTokens: Number(generation.fastGenerationMaxOutputTokens ?? 2200),
      maxOutputTokens: Number(generation.maxOutputTokens ?? 8000),
    },
    prompts: {
      widget: prompts.widget || defaultPrompts.widget || "",
      "landing-page": prompts["landing-page"] || defaultPrompts["landing-page"] || "",
      collection: prompts.collection || defaultPrompts.collection || "",
    },
    defaultPrompts: {
      widget: defaultPrompts.widget || "",
      "landing-page": defaultPrompts["landing-page"] || "",
      collection: defaultPrompts.collection || "",
    },
  };
}

async function fetchWidgetAi(): Promise<WidgetAiValues> {
  const data = (await getWidgetAiSettings()) as Record<string, unknown>;
  return normalizeWidgetAiSettingsData(data);
}

export function buildWidgetAiSettingsUpdate(
  values: WidgetAiValues,
): UpdateWidgetAiSettingsInput {
  const apiKeys = Object.fromEntries(
    PROVIDERS
      .map(({ id }) => [id, values.providers[id].apiKeyInput.trim()] as const)
      .filter(([, value]) => value.length > 0),
  );

  return {
    activeProvider: values.activeProvider,
    providers: Object.fromEntries(
      PROVIDERS.map(({ id }) => {
        const provider = values.providers[id];
        return [
          id,
          {
            enabled: provider.enabled,
            defaultModel: normalizeModelIdForProvider(
              id,
              provider.defaultModel,
            ),
            allowedModels: normalizeAllowedModels(provider.allowedModels, id),
            capabilities: {
              structuredOutput: provider.capabilities.structuredOutput,
              visionInput: provider.capabilities.visionInput,
              maxImages: normalizeMaxImages(provider.capabilities.maxImages),
            },
            baseUrl: provider.baseUrl.trim(),
            appName: provider.appName.trim(),
            appUrl: provider.appUrl.trim(),
            accountId: provider.accountId.trim(),
          },
        ];
      }),
    ),
    profiles: Object.fromEntries(
      PROFILE_DEFINITIONS.map(({ id }) => {
        const profile = values.profiles[id];
        return [
          id,
          {
            enabled: profile.enabled,
            provider: profile.provider,
            model: normalizeModelIdForProvider(
              profile.provider,
              profile.model,
            ),
          },
        ];
      }),
    ),
    generation: values.generation,
    prompts: values.prompts,
    apiKeys,
    clearApiKeys: PROVIDERS
      .map(({ id }) => id)
      .filter((id) => values.providers[id].clearApiKey && !values.providers[id].apiKeyInput.trim()),
  };
}

async function saveWidgetAi(values: WidgetAiValues) {
  await updateWidgetAiSettings({
    data: buildWidgetAiSettingsUpdate(values),
  });
}

export default function WidgetAiSettingsBuilder() {
  const { values, setValues, isLoading, isSaving, handleSubmit } =
    useSettingsForm<WidgetAiValues>({
      queryKey: queryKeys.settings.widgetAi(),
      fetchFn: fetchWidgetAi,
      saveFn: saveWidgetAi,
      defaultValues,
      successMessage: "Widget AI settings saved.",
      errorMessage: "Failed to save widget AI settings.",
    });

  const active = values.providers[values.activeProvider];
  const activeHasUsableCredential = Boolean(
    active?.apiKeyInput.trim() ||
      active?.hasBinding ||
      (active?.hasApiKey && !active?.clearApiKey),
  );
  const activeReady = Boolean(
    active?.enabled && active?.defaultModel.trim() && activeHasUsableCredential,
  );

  const setActiveProvider = (provider: ProviderId) => {
    setValues((prev) => {
      const model = prev.providers[provider].defaultModel || prev.profiles.widgetGeneration.model;
      return {
        ...prev,
        activeProvider: provider,
        profiles: {
          ...prev.profiles,
          widgetGeneration: {
            ...prev.profiles.widgetGeneration,
            provider,
            model,
          },
        },
      };
    });
  };

  const setProviderValue = <K extends keyof ProviderValues>(
    provider: ProviderId,
    key: K,
    value: ProviderValues[K],
  ) => {
    setValues((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [provider]: {
          ...prev.providers[provider],
          [key]: value,
        },
      },
    }));
  };

  const setProviderCapabilityValue = <K extends keyof ProviderCapabilityValues>(
    provider: ProviderId,
    key: K,
    value: ProviderCapabilityValues[K],
  ) => {
    setValues((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [provider]: {
          ...prev.providers[provider],
          capabilities: {
            ...prev.providers[provider].capabilities,
            [key]: value,
          },
        },
      },
    }));
  };

  const setProfileValue = <K extends keyof ModelProfileValues>(
    profile: ProfileId,
    key: K,
    value: ModelProfileValues[K],
  ) => {
    setValues((prev) => ({
      ...prev,
      profiles: {
        ...prev.profiles,
        [profile]: {
          ...prev.profiles[profile],
          [key]: value,
        },
      },
    }));
  };

  const setProfileEnabled = (profile: ProfileId, enabled: boolean) => {
    setValues((prev) => {
      const current = prev.profiles[profile];
      const provider =
        profile === "imageGeneration" &&
        !isImageGenerationProvider(current.provider)
          ? "cloudflare"
          : current.provider;
      const modelOptions = getProfileModelOptions(
        profile,
        prev.providers,
        provider,
      );
      const currentModelIsCompatible =
        profile !== "imageGeneration" ||
        isImageGenerationModel(provider, current.model);
      return {
        ...prev,
        profiles: {
          ...prev.profiles,
          [profile]: {
            ...current,
            provider,
            enabled,
            model:
              enabled && (!current.model.trim() || !currentModelIsCompatible)
                ? modelOptions[0] || prev.providers[provider].defaultModel || ""
                : current.model,
          },
        },
      };
    });
  };

  const setProfileProvider = (profile: ProfileId, provider: ProviderId) => {
    setValues((prev) => {
      const nextOptions = getProfileModelOptions(profile, prev.providers, provider);
      const current = prev.profiles[profile];
      const keepCurrent =
        profile === "imageGeneration"
          ? isImageGenerationModel(provider, current.model)
          : Boolean(current.model);
      return {
        ...prev,
        profiles: {
          ...prev.profiles,
          [profile]: {
            ...current,
            provider,
            model: keepCurrent ? current.model : nextOptions[0] || "",
          },
        },
      };
    });
  };

  const setGenerationValue = <K extends keyof WidgetAiValues["generation"]>(
    key: K,
    value: WidgetAiValues["generation"][K],
  ) => {
    setValues((prev) => ({
      ...prev,
      generation: { ...prev.generation, [key]: value },
    }));
  };

  const setPrompt = (prompt: PromptId, value: string) => {
    setValues((prev) => ({
      ...prev,
      prompts: { ...prev.prompts, [prompt]: value },
    }));
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="grid gap-4 md:grid-cols-[1fr_220px] md:items-end">
        <div className="space-y-2">
          <Label htmlFor="widget-ai-provider">Active provider</Label>
          <Select
            value={values.activeProvider}
            onValueChange={(value) => setActiveProvider(value as ProviderId)}
          >
            <SelectTrigger id="widget-ai-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Widget generation uses this provider unless a future workflow overrides it.
          </p>
        </div>
        <div
          className={cn(
            "rounded-md border p-3 text-sm",
            activeReady
              ? "border-emerald-500/30 bg-emerald-500/5"
              : "border-amber-500/30 bg-amber-500/5",
          )}
        >
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="h-4 w-4" />
            {activeReady ? "Ready" : "Needs configuration"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {active?.defaultModel || "Choose a model before generating."}
          </p>
        </div>
      </div>

      <section className="space-y-3 rounded-md border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Model profiles</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Admin chat is live in the dashboard. Other assistant surfaces stay disabled until their UI is released.
            </p>
          </div>
          <Badge variant="outline">Compact setup</Badge>
        </div>

        <div className="grid gap-2">
          {PROFILE_DEFINITIONS.map((profile) => {
            const profileValues = values.profiles[profile.id];
            const modelOptions = getProfileModelOptions(
              profile.id,
              values.providers,
              profileValues.provider,
            );
            return (
              <div
                key={profile.id}
                className={cn(
                  "grid gap-3 rounded-md border p-3 md:grid-cols-[minmax(180px,1fr)_160px_minmax(180px,1fr)_auto] md:items-center",
                  profileValues.enabled ? "bg-background" : "bg-muted/20",
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-medium">{profile.label}</h4>
                    <Badge variant={profile.id === "widgetGeneration" ? "secondary" : "outline"}>
                      {profile.badge}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{profile.description}</p>
                </div>

                <div className="space-y-1">
                  <Label className="sr-only" htmlFor={`profile-${profile.id}-provider`}>
                    Provider
                  </Label>
                  <Select
                    value={profileValues.provider}
                    onValueChange={(value) => setProfileProvider(profile.id, value as ProviderId)}
                    disabled={!profileValues.enabled}
                  >
                    <SelectTrigger id={`profile-${profile.id}-provider`} className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.filter(
                        (provider) =>
                          profile.id !== "imageGeneration" ||
                          isImageGenerationProvider(provider.id),
                      ).map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="sr-only" htmlFor={`profile-${profile.id}-model`}>
                    Model
                  </Label>
                  <Input
                    id={`profile-${profile.id}-model`}
                    name={`widget-ai-profile-${profile.id}-model`}
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    className="h-9"
                    list={`profile-${profile.id}-models`}
                    value={profileValues.model}
                    disabled={!profileValues.enabled}
                    onChange={(event) => setProfileValue(profile.id, "model", event.target.value)}
                    onBlur={(event) =>
                      setProfileValue(
                        profile.id,
                        "model",
                        normalizeModelIdForProvider(
                          profileValues.provider,
                          event.target.value,
                        ),
                      )
                    }
                    placeholder="Model ID"
                  />
                  {modelOptions.length > 0 && (
                    <datalist id={`profile-${profile.id}-models`}>
                      {modelOptions.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 md:justify-end">
                  <Label
                    htmlFor={`profile-${profile.id}-enabled`}
                    className="text-xs text-muted-foreground"
                  >
                    Enabled
                  </Label>
                  <Switch
                    id={`profile-${profile.id}-enabled`}
                    checked={profileValues.enabled}
                    onCheckedChange={(checked) => setProfileEnabled(profile.id, checked)}
                    aria-label={`Enable ${profile.label} profile`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-4">
        {PROVIDERS.map((provider) => {
          const valuesForProvider = values.providers[provider.id];
          const supportsBaseUrl = provider.id !== "cloudflare";
          const isCloudflare = provider.id === "cloudflare";
          return (
            <section key={provider.id} className="rounded-md border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{provider.label}</h3>
                    {provider.id === values.activeProvider && <Badge>Active</Badge>}
                    {(valuesForProvider.hasApiKey || valuesForProvider.hasBinding) && (
                      <Badge variant="outline">Configured</Badge>
                    )}
                    {isCloudflare && valuesForProvider.hasBinding && (
                      <Badge variant="secondary">Workers AI binding</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{provider.hint}</p>
                  {isCloudflare && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      The Worker binding is preferred for production generation. Use @cf/vendor/model for Workers AI models or provider/model for unified catalog models that your Cloudflare account can access.
                    </p>
                  )}
                </div>
                <Switch
                  checked={valuesForProvider.enabled}
                  onCheckedChange={(checked) => setProviderValue(provider.id, "enabled", checked)}
                  aria-label={`Enable ${provider.label}`}
                />
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`${provider.id}-model`}>Default model</Label>
                  <Input
                    id={`${provider.id}-model`}
                    name={`widget-ai-${provider.id}-model`}
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    value={valuesForProvider.defaultModel}
                    onChange={(event) => setProviderValue(provider.id, "defaultModel", event.target.value)}
                    onBlur={(event) =>
                      setProviderValue(
                        provider.id,
                        "defaultModel",
                        normalizeModelIdForProvider(
                          provider.id,
                          event.target.value,
                        ),
                      )
                    }
                    placeholder={provider.id === "cloudflare" ? "@cf/vendor/model or google/gemini-3.5-flash" : "Model ID"}
                  />
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor={`${provider.id}-allowed-models`}>
                    {isCloudflare ? "Quick-pick model suggestions" : "Additional allowed models"}
                  </Label>
                  <Textarea
                    id={`${provider.id}-allowed-models`}
                    name={`widget-ai-${provider.id}-allowed-models`}
                    rows={3}
                    value={valuesForProvider.allowedModels.join("\n")}
                    onChange={(event) =>
                      setProviderValue(
                        provider.id,
                        "allowedModels",
                        parseAllowedModelsText(event.target.value, provider.id),
                      )
                    }
                    placeholder={
                      isCloudflare
                        ? "One Cloudflare model ID per line for dropdown suggestions."
                        : "One model ID per line. The default model is always allowed."
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {isCloudflare
                      ? "Cloudflare profiles can use any valid Cloudflare AI text model ID. This list only keeps common choices easy to pick."
                      : "Widget generation can only use the default model and these additional model IDs."}
                  </p>
                </div>

                <div className="grid gap-4 rounded-md border bg-muted/20 p-3 md:col-span-2 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor={`${provider.id}-structured-output`}>Structured output</Label>
                    <Select
                      value={valuesForProvider.capabilities.structuredOutput}
                      onValueChange={(value) =>
                        setProviderCapabilityValue(
                          provider.id,
                          "structuredOutput",
                          value as StructuredOutputMode,
                        )
                      }
                    >
                      <SelectTrigger id={`${provider.id}-structured-output`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STRUCTURED_OUTPUT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={`${provider.id}-vision-input`}>Image input</Label>
                    <Select
                      value={valuesForProvider.capabilities.visionInput}
                      onValueChange={(value) =>
                        setProviderCapabilityValue(
                          provider.id,
                          "visionInput",
                          value as VisionInputMode,
                        )
                      }
                    >
                      <SelectTrigger id={`${provider.id}-vision-input`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VISION_INPUT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={`${provider.id}-max-images`}>Max images</Label>
                    <Input
                      id={`${provider.id}-max-images`}
                      type="number"
                      min={0}
                      max={10}
                      step={1}
                      value={valuesForProvider.capabilities.maxImages}
                      onChange={(event) =>
                        setProviderCapabilityValue(
                          provider.id,
                          "maxImages",
                          normalizeMaxImages(event.target.value),
                        )
                      }
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`${provider.id}-key`}>
                    <span className="inline-flex items-center gap-2">
                      <KeyRound className="h-3.5 w-3.5" />
                      API key
                    </span>
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id={`${provider.id}-key`}
                      name={`widget-ai-${provider.id}-api-key`}
                      type="password"
                      autoComplete="new-password"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      value={valuesForProvider.apiKeyInput}
                      onChange={(event) => {
                        setProviderValue(provider.id, "apiKeyInput", event.target.value);
                        if (event.target.value) setProviderValue(provider.id, "clearApiKey", false);
                      }}
                      placeholder={valuesForProvider.hasApiKey ? "Configured. Leave blank to keep." : "Paste API key"}
                    />
                    <Button
                      type="button"
                      variant={valuesForProvider.clearApiKey ? "destructive" : "outline"}
                      size="icon"
                      title="Clear saved key on next save"
                      disabled={!valuesForProvider.hasApiKey}
                      onClick={() =>
                        setProviderValue(provider.id, "clearApiKey", !valuesForProvider.clearApiKey)
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {supportsBaseUrl && (
                  <div className="space-y-2">
                    <Label htmlFor={`${provider.id}-base-url`}>Base URL</Label>
                    <Input
                      id={`${provider.id}-base-url`}
                      name={`widget-ai-${provider.id}-base-url`}
                      autoComplete="off"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      value={valuesForProvider.baseUrl}
                      onChange={(event) => setProviderValue(provider.id, "baseUrl", event.target.value)}
                    />
                  </div>
                )}

                {provider.id === "openrouter" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="openrouter-app-name">App name</Label>
                      <Input
                        id="openrouter-app-name"
                        name="widget-ai-openrouter-app-name"
                        autoComplete="off"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        value={valuesForProvider.appName}
                        onChange={(event) => setProviderValue("openrouter", "appName", event.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="openrouter-app-url">App URL</Label>
                      <Input
                        id="openrouter-app-url"
                        name="widget-ai-openrouter-app-url"
                        autoComplete="off"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        value={valuesForProvider.appUrl}
                        onChange={(event) => setProviderValue("openrouter", "appUrl", event.target.value)}
                        placeholder="https://your-store.example"
                      />
                    </div>
                  </>
                )}

                {provider.id === "cloudflare" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="cloudflare-account-id">Account ID for REST fallback</Label>
                      <Input
                        id="cloudflare-account-id"
                        name="widget-ai-cloudflare-account-id"
                        autoComplete="off"
                        data-lpignore="true"
                        data-1p-ignore="true"
                        value={valuesForProvider.accountId}
                        onChange={(event) => setProviderValue("cloudflare", "accountId", event.target.value)}
                        placeholder="32-character Cloudflare account ID"
                      />
                    </div>
                    <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground md:col-span-2">
                      <div className="font-medium text-foreground">Cloudflare mode</div>
                      <div className="mt-1">
                        {valuesForProvider.hasBinding
                          ? "Binding active: generation works without a stored API token."
                          : "Binding missing: add account ID and API token for REST fallback generation."}
                      </div>
                      <div className="mt-1">
                        REST fallback: {valuesForProvider.hasApiKey && valuesForProvider.accountId ? "configured" : "not configured"}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <section className="space-y-4 rounded-md border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold">Generation defaults</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            These defaults apply to widget creation and improvement. The platform always builds one cohesive destination-aware artifact.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="planning-temperature">Planning temperature</Label>
            <Input
              id="planning-temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={values.generation.planningTemperature}
              onChange={(event) => setGenerationValue("planningTemperature", Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="generation-temperature">Generation temperature</Label>
            <Input
              id="generation-temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={values.generation.generationTemperature}
              onChange={(event) => setGenerationValue("generationTemperature", Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="improvement-temperature">Improvement temperature</Label>
            <Input
              id="improvement-temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={values.generation.improvementTemperature}
              onChange={(event) => setGenerationValue("improvementTemperature", Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fast-max-output-tokens">Fast output tokens</Label>
            <Input
              id="fast-max-output-tokens"
              type="number"
              min={512}
              max={64000}
              step={256}
              value={values.generation.fastGenerationMaxOutputTokens}
              onChange={(event) => setGenerationValue("fastGenerationMaxOutputTokens", Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="max-output-tokens">Max output tokens</Label>
            <Input
              id="max-output-tokens"
              type="number"
              min={512}
              max={64000}
              step={512}
              value={values.generation.maxOutputTokens}
              onChange={(event) => setGenerationValue("maxOutputTokens", Number(event.target.value))}
            />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-md border border-border p-4">
        <div>
          <h3 className="text-sm font-semibold">System prompts</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Prompts are stored locally in the platform settings and never loaded from third-party prompt URLs.
          </p>
        </div>
        {PROMPTS.map((prompt) => (
          <div key={prompt.id} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={`prompt-${prompt.id}`}>{prompt.label}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPrompt(prompt.id, values.defaultPrompts[prompt.id])}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Reset
              </Button>
            </div>
            <Textarea
              id={`prompt-${prompt.id}`}
              value={values.prompts[prompt.id]}
              onChange={(event) => setPrompt(prompt.id, event.target.value)}
              rows={7}
              className="font-mono text-xs"
            />
          </div>
        ))}
      </section>

      <div className="flex justify-end border-t border-border pt-4">
        <Button onClick={handleSubmit} disabled={isSaving} className="min-w-[180px]">
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Save Widget AI
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
