import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  getAllowedWidgetAiModels,
  maskWidgetAiAdminSettings,
  normalizeWidgetAiConfig,
  providerHasCredentials,
  requireAllowedWidgetAiModel,
  type WidgetAiRuntimeSettings,
} from "./ai-settings.service";
import { ValidationError } from "@scalius/core/errors";
import {
  resolveWidgetAiModelCapabilities,
  supportsWidgetAiVisionInput,
} from "./ai-config";
import { DEFAULT_AI_PROMPTS } from "./default-prompts";

describe("widget AI settings", () => {
  it("normalizes malformed config to safe defaults", () => {
    const config = normalizeWidgetAiConfig({
      activeProvider: "missing",
      providers: {
        openrouter: {
          enabled: "yes",
          defaultModel: 123,
          allowedModels: [
            " openai/gpt-5.4 ",
            "",
            "openai/gpt-5.4",
            "x".repeat(201),
            "anthropic/claude-sonnet-4.5",
          ],
          baseUrl: " https://openrouter.ai/api/v1 ",
        },
      },
      generation: {
        planningTemperature: -2,
        generationTemperature: 4,
        maxOutputTokens: 100000,
      },
    });

    expect(config.activeProvider).toBe(DEFAULT_WIDGET_AI_CONFIG.activeProvider);
    expect(config.providers.openrouter.enabled).toBe(false);
    expect(config.providers.openrouter.defaultModel).toBe("");
    expect(config.providers.openrouter.allowedModels).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4.5",
    ]);
    expect(config.providers.openrouter.capabilities).toEqual({
      structuredOutput: "auto",
      visionInput: "auto",
    });
    expect(config.providers.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.providers.cloudflare.enabled).toBe(true);
    expect(config.providers.cloudflare.defaultModel).toBe("@cf/moonshotai/kimi-k2.6");
    expect(config.generation.planningTemperature).toBe(0);
    expect(config.generation.generationTemperature).toBe(2);
    expect(config.generation.fastGenerationMaxOutputTokens).toBe(2200);
    expect(config.generation.maxOutputTokens).toBe(64000);
  });

  it("rejects arbitrary provider base URLs", () => {
    expect(() =>
      normalizeWidgetAiConfig({
        providers: { openai: { baseUrl: "https://proxy.example/v1" } },
      }),
    ).toThrow("Unsupported openai base URL");
  });

  it("rejects malformed Cloudflare account IDs", () => {
    expect(() =>
      normalizeWidgetAiConfig({
        providers: { cloudflare: { accountId: "not-an-account-id" } },
      }),
    ).toThrow("Cloudflare account ID");
  });

  it("treats Cloudflare binding as valid credentials", () => {
    const runtime: WidgetAiRuntimeSettings = {
      ...DEFAULT_WIDGET_AI_CONFIG,
      apiKeys: {},
      hasCloudflareBinding: true,
    };

    expect(providerHasCredentials(runtime, "cloudflare")).toBe(true);
    expect(providerHasCredentials(runtime, "openai")).toBe(false);
  });

  it("uses the default model and configured allowlist as the allowed model set", () => {
    const runtime: WidgetAiRuntimeSettings = {
      ...DEFAULT_WIDGET_AI_CONFIG,
      providers: {
        ...DEFAULT_WIDGET_AI_CONFIG.providers,
        cloudflare: {
          ...DEFAULT_WIDGET_AI_CONFIG.providers.cloudflare,
          defaultModel: "@cf/moonshotai/kimi-k2.6",
          allowedModels: [
            "@cf/openai/gpt-oss-120b",
            "@cf/moonshotai/kimi-k2.6",
          ],
        },
      },
      apiKeys: {},
      hasCloudflareBinding: true,
    };

    expect(getAllowedWidgetAiModels(runtime, "cloudflare")).toEqual([
      "@cf/moonshotai/kimi-k2.6",
      "@cf/openai/gpt-oss-120b",
    ]);
    expect(requireAllowedWidgetAiModel(runtime, "cloudflare", undefined)).toBe(
      "@cf/moonshotai/kimi-k2.6",
    );
    expect(
      requireAllowedWidgetAiModel(
        runtime,
        "cloudflare",
        "@cf/openai/gpt-oss-120b",
      ),
    ).toBe("@cf/openai/gpt-oss-120b");
  });

  it("rejects widget generation models that are not enabled by settings", () => {
    const runtime: WidgetAiRuntimeSettings = {
      ...DEFAULT_WIDGET_AI_CONFIG,
      apiKeys: {},
      hasCloudflareBinding: true,
    };

    expect(() =>
      requireAllowedWidgetAiModel(
        runtime,
        "cloudflare",
        "@cf/openai/gpt-oss-120b",
      ),
    ).toThrow(ValidationError);
  });

  it("keeps Cloudflare widget generation text-only until image bytes are adapted server-side", () => {
    expect(supportsWidgetAiVisionInput("cloudflare", "@cf/moonshotai/kimi-k2.6")).toBe(false);
    expect(supportsWidgetAiVisionInput("cloudflare", "@cf/openai/gpt-oss-120b")).toBe(false);
    expect(supportsWidgetAiVisionInput("gemini", "gemini-3-pro")).toBe(true);
    expect(supportsWidgetAiVisionInput("openai", "gpt-5.4")).toBe(true);
    expect(supportsWidgetAiVisionInput("openrouter", "google/gemini-3-pro")).toBe(false);
  });

  it("resolves provider capabilities with admin overrides", () => {
    expect(resolveWidgetAiModelCapabilities("cloudflare", "@cf/moonshotai/kimi-k2.6")).toMatchObject({
      supportsStructuredOutput: false,
      structuredOutputMode: "text",
      supportsVisionInput: false,
      maxImages: 6,
    });

    expect(resolveWidgetAiModelCapabilities("openai", "gpt-5.4")).toMatchObject({
      supportsStructuredOutput: true,
      structuredOutputMode: "sdk",
      supportsVisionInput: true,
      maxImages: 6,
    });

    const forced = resolveWidgetAiModelCapabilities("cloudflare", "@cf/moonshotai/kimi-k2.6", {
      structuredOutput: "sdk",
      visionInput: "enabled",
      maxImages: 4,
    });

    expect(forced.supportsStructuredOutput).toBe(true);
    expect(forced.supportsVisionInput).toBe(true);
    expect(forced.maxImages).toBe(4);
    expect(forced.notes).toHaveLength(2);
  });

  it("masks runtime secrets from admin settings responses", () => {
    const runtime: WidgetAiRuntimeSettings = {
      ...DEFAULT_WIDGET_AI_CONFIG,
      apiKeys: {
        openai: "sk-prod-openai",
        cloudflare: "cf-prod-token",
      },
      hasCloudflareBinding: true,
    };

    const adminSettings = maskWidgetAiAdminSettings(
      runtime,
      DEFAULT_AI_PROMPTS,
    );
    const serialized = JSON.stringify(adminSettings);

    expect("apiKeys" in adminSettings).toBe(false);
    expect(serialized).not.toContain("sk-prod-openai");
    expect(serialized).not.toContain("cf-prod-token");
    expect(adminSettings.providers.openai.hasApiKey).toBe(true);
    expect(adminSettings.providers.cloudflare.hasApiKey).toBe(true);
    expect(adminSettings.providers.cloudflare.hasBinding).toBe(true);
  });
});
