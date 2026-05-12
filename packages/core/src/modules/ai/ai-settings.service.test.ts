import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  maskWidgetAiAdminSettings,
  normalizeWidgetAiConfig,
  providerHasCredentials,
  type WidgetAiRuntimeSettings,
} from "./ai-settings.service";
import { DEFAULT_AI_PROMPTS } from "./default-prompts";

describe("widget AI settings", () => {
  it("normalizes malformed config to safe defaults", () => {
    const config = normalizeWidgetAiConfig({
      activeProvider: "missing",
      providers: {
        openrouter: {
          enabled: "yes",
          defaultModel: 123,
          baseUrl: " https://openrouter.ai/api/v1 ",
        },
      },
      generation: {
        planningTemperature: -2,
        generationTemperature: 4,
        maxOutputTokens: 100000,
        stagedGenerationDefault: "yes",
      },
    });

    expect(config.activeProvider).toBe(DEFAULT_WIDGET_AI_CONFIG.activeProvider);
    expect(config.providers.openrouter.enabled).toBe(false);
    expect(config.providers.openrouter.defaultModel).toBe("");
    expect(config.providers.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.providers.cloudflare.enabled).toBe(true);
    expect(config.providers.cloudflare.defaultModel).toBe("@cf/moonshotai/kimi-k2.6");
    expect(config.generation.planningTemperature).toBe(0);
    expect(config.generation.generationTemperature).toBe(2);
    expect(config.generation.maxOutputTokens).toBe(64000);
    expect(config.generation.stagedGenerationDefault).toBe(true);
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
