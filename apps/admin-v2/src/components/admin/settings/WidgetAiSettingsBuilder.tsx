import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { getWidgetAiSettings, updateWidgetAiSettings } from "@/lib/api-functions/settings";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@scalius/shared/utils";
import { CheckCircle2, KeyRound, Loader2, RotateCcw, Save, Trash2 } from "lucide-react";

type ProviderId = "openrouter" | "openai" | "gemini" | "cloudflare";
type PromptId = "widget" | "landing-page" | "collection";
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

interface WidgetAiValues {
  activeProvider: ProviderId;
  providers: Record<ProviderId, ProviderValues>;
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
  { id: "cloudflare", label: "Cloudflare", hint: "Workers AI binding or API token" },
];

const PROMPTS: Array<{ id: PromptId; label: string }> = [
  { id: "widget", label: "Homepage Widget" },
  { id: "landing-page", label: "Landing Page" },
  { id: "collection", label: "Collection Page" },
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

function normalizeAllowedModels(value: unknown): string[] {
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

function parseAllowedModelsText(value: string): string[] {
  return normalizeAllowedModels(value.split(/\r?\n|,/));
}

function normalizeProvider(id: ProviderId, value: unknown): ProviderValues {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<ProviderValues>)
      : {};
  return {
    ...defaultValues.providers[id],
    enabled: typeof data.enabled === "boolean" ? data.enabled : defaultValues.providers[id].enabled,
    defaultModel: typeof data.defaultModel === "string" ? data.defaultModel : defaultValues.providers[id].defaultModel,
    allowedModels: normalizeAllowedModels(data.allowedModels),
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

function normalizeProviderId(value: unknown): ProviderId {
  return PROVIDERS.some((provider) => provider.id === value)
    ? (value as ProviderId)
    : defaultValues.activeProvider;
}

async function fetchWidgetAi(): Promise<WidgetAiValues> {
  const data = (await getWidgetAiSettings()) as Record<string, unknown>;
  const providers = (data.providers ?? {}) as Record<string, unknown>;
  const prompts = (data.prompts ?? {}) as Partial<Record<PromptId, string>>;
  const defaultPrompts = (data.defaultPrompts ?? {}) as Partial<Record<PromptId, string>>;
  const generation = (data.generation ?? {}) as Partial<WidgetAiValues["generation"]>;

  return {
    activeProvider: normalizeProviderId(data.activeProvider),
    providers: {
      openrouter: normalizeProvider("openrouter", providers.openrouter),
      openai: normalizeProvider("openai", providers.openai),
      gemini: normalizeProvider("gemini", providers.gemini),
      cloudflare: normalizeProvider("cloudflare", providers.cloudflare),
    },
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

async function saveWidgetAi(values: WidgetAiValues) {
  const apiKeys = Object.fromEntries(
    PROVIDERS
      .map(({ id }) => [id, values.providers[id].apiKeyInput.trim()] as const)
      .filter(([, value]) => value.length > 0),
  );

  await updateWidgetAiSettings({
    data: {
      activeProvider: values.activeProvider,
      providers: Object.fromEntries(
        PROVIDERS.map(({ id }) => {
          const provider = values.providers[id];
          return [
            id,
            {
              enabled: provider.enabled,
              defaultModel: provider.defaultModel.trim(),
              allowedModels: normalizeAllowedModels(provider.allowedModels),
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
      generation: values.generation,
      prompts: values.prompts,
      apiKeys,
      clearApiKeys: PROVIDERS
        .map(({ id }) => id)
        .filter((id) => values.providers[id].clearApiKey && !values.providers[id].apiKeyInput.trim()),
    },
  });
}

export default function WidgetAiSettingsBuilder() {
  const { values, setValue, setValues, isLoading, isSaving, handleSubmit } =
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
            onValueChange={(value) => setValue("activeProvider", value as ProviderId)}
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
                      The Worker binding is preferred for production generation. Account ID and API key are optional REST fallback/model-catalog credentials.
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
                    placeholder={provider.id === "cloudflare" ? "@cf/vendor/model" : "Model ID"}
                  />
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor={`${provider.id}-allowed-models`}>Additional allowed models</Label>
                  <Textarea
                    id={`${provider.id}-allowed-models`}
                    name={`widget-ai-${provider.id}-allowed-models`}
                    rows={3}
                    value={valuesForProvider.allowedModels.join("\n")}
                    onChange={(event) =>
                      setProviderValue(
                        provider.id,
                        "allowedModels",
                        parseAllowedModelsText(event.target.value),
                      )
                    }
                    placeholder="One model ID per line. The default model is always allowed."
                  />
                  <p className="text-xs text-muted-foreground">
                    Widget generation can only use the default model and these additional model IDs.
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
