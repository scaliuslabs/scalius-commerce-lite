import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  getAllowedWidgetAiModels,
  getWidgetAiAdminSettings,
  getWidgetAiProviderCredentialError,
  getWidgetAiRuntimeSettings,
  maskWidgetAiAdminSettings,
  normalizeWidgetAiConfig,
  providerHasCredentials,
  requireAllowedWidgetAiModel,
  resolveAiModelProfile,
  updateWidgetAiSettings,
  type WidgetAiRuntimeSettings,
} from "./ai-settings.service";
import { ValidationError } from "@scalius/core/errors";
import { encryptCredentials } from "@scalius/core/utils/credential-encryption";
import {
  AI_MODEL_PROFILE_IDS,
  resolveWidgetAiModelCapabilities,
  supportsWidgetAiVisionInput,
} from "./ai-config";
import { DEFAULT_AI_PROMPTS } from "./default-prompts";

function credentialKey(byte: number) {
  return Buffer.alloc(32, byte).toString("base64");
}

function createAiSettingsDb(rows: Array<{ key: string; value: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          all: async () => rows,
        }),
      }),
    }),
  };
}

function createWritableAiSettingsDb(
  rows: Array<{ key: string; value: string }>,
  writes: Array<{ key: string; value: string; type?: string }>,
) {
  return {
    ...createAiSettingsDb(rows),
    insert: () => ({
      values: (value: { key: string; value: string; type?: string }) => ({
        onConflictDoUpdate: async () => {
          writes.push(value);
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
  };
}

function widgetAiConfigRow(value: unknown) {
  return {
    key: "widget_generation_config",
    value: JSON.stringify(value),
  };
}

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

  it("normalizes legacy widget config into the widgetGeneration model profile", () => {
    const config = normalizeWidgetAiConfig({
      activeProvider: "openai",
      providers: {
        openai: {
          enabled: true,
          defaultModel: "gpt-5.4",
          allowedModels: ["gpt-5.4-mini"],
        },
      },
    });

    expect(config.profiles.widgetGeneration).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(config.profiles.adminChat.enabled).toBe(false);
    expect(config.profiles.storefrontChat.enabled).toBe(false);
    expect(config.profiles.imageGeneration.enabled).toBe(false);
    expect(config.profiles.voice.enabled).toBe(false);
  });

  it("keeps assistant profiles disabled in static defaults", () => {
    const config = normalizeWidgetAiConfig({});
    const runtime: WidgetAiRuntimeSettings = {
      ...config,
      apiKeys: {},
      credentialErrors: {},
      hasCloudflareBinding: true,
    };

    expect(config.profiles.widgetGeneration).toEqual({
      enabled: true,
      provider: "cloudflare",
      model: "@cf/moonshotai/kimi-k2.6",
    });
    for (const profileId of [
      "adminChat",
      "storefrontChat",
      "imageGeneration",
      "voice",
    ] as const) {
      expect(config.profiles[profileId]).toEqual({
        enabled: false,
        provider: "cloudflare",
        model: "",
      });
      expect(() => resolveAiModelProfile(runtime, profileId)).toThrow(
        `AI model profile "${profileId}" is disabled.`,
      );
    }
  });

  it("enables unconfigured chat runtime profiles with the same safe Cloudflare default", async () => {
    const runtime = await getWidgetAiRuntimeSettings(
      createAiSettingsDb([]) as never,
      { AI: { run: async () => ({}) } },
    );

    expect(runtime.profiles.adminChat).toEqual({
      enabled: true,
      provider: "cloudflare",
      model: "@cf/moonshotai/kimi-k2.6",
    });
    expect(runtime.profiles.storefrontChat).toEqual({
      enabled: true,
      provider: "cloudflare",
      model: "@cf/moonshotai/kimi-k2.6",
    });
    expect(runtime.apiKeys).toEqual({});
    expect(runtime.hasCloudflareBinding).toBe(true);
    expect(resolveAiModelProfile(runtime, "adminChat")).toMatchObject({
      id: "adminChat",
      provider: "cloudflare",
      model: "@cf/moonshotai/kimi-k2.6",
    });
    expect(resolveAiModelProfile(runtime, "storefrontChat")).toMatchObject({
      id: "storefrontChat",
      provider: "cloudflare",
      model: "@cf/moonshotai/kimi-k2.6",
    });
  });

  it("does not enable default adminChat without the Cloudflare AI binding", async () => {
    const runtime = await getWidgetAiRuntimeSettings(
      createAiSettingsDb([]) as never,
      {},
    );

    expect(runtime.profiles.adminChat).toEqual({
      enabled: false,
      provider: "cloudflare",
      model: "",
    });
    expect(runtime.profiles.storefrontChat).toEqual({
      enabled: false,
      provider: "cloudflare",
      model: "",
    });
    expect(() => resolveAiModelProfile(runtime, "adminChat")).toThrow(
      'AI model profile "adminChat" is disabled.',
    );
  });

  it("does not override an explicitly configured disabled adminChat profile", async () => {
    const runtime = await getWidgetAiRuntimeSettings(
      createAiSettingsDb([
        widgetAiConfigRow({
          profiles: {
            adminChat: {
              enabled: false,
              provider: "cloudflare",
              model: "@cf/openai/gpt-oss-120b",
            },
          },
        }),
      ]) as never,
      { AI: { run: async () => ({}) } },
    );

    expect(runtime.profiles.adminChat).toEqual({
      enabled: false,
      provider: "cloudflare",
      model: "@cf/openai/gpt-oss-120b",
    });
    expect(() => resolveAiModelProfile(runtime, "adminChat")).toThrow(
      'AI model profile "adminChat" is disabled.',
    );
  });

  it("preserves an explicitly disabled storefrontChat profile, including an empty model", async () => {
    const runtime = await getWidgetAiRuntimeSettings(
      createAiSettingsDb([
        widgetAiConfigRow({
          profiles: {
            storefrontChat: {
              enabled: false,
              provider: "cloudflare",
              model: "",
            },
          },
        }),
      ]) as never,
      { AI: { run: async () => ({}) } },
    );

    expect(runtime.profiles.adminChat).toEqual({
      enabled: true,
      provider: "cloudflare",
      model: "@cf/moonshotai/kimi-k2.6",
    });
    expect(runtime.profiles.storefrontChat).toEqual({
      enabled: false,
      provider: "cloudflare",
      model: "",
    });
    expect(() => resolveAiModelProfile(runtime, "storefrontChat")).toThrow(
      'AI model profile "storefrontChat" is disabled.',
    );
  });

  it("honors an explicitly configured Cloudflare catalog model outside the local suggestions", async () => {
    const runtime = await getWidgetAiRuntimeSettings(
      createAiSettingsDb([
        widgetAiConfigRow({
          providers: {
            cloudflare: {
              enabled: true,
              defaultModel: "@cf/openai/gpt-oss-120b",
              allowedModels: [
                "@cf/openai/gpt-oss-120b",
                "@cf/moonshotai/kimi-k2.6",
              ],
            },
          },
          profiles: {
            adminChat: {
              enabled: true,
              provider: "cloudflare",
              model: "google/gemini-3.5-flash",
            },
          },
        }),
      ]) as never,
      { AI: { run: async () => ({}) } },
    );

    expect(runtime.profiles.adminChat).toEqual({
      enabled: true,
      provider: "cloudflare",
      model: "google/gemini-3.5-flash",
    });
    expect(resolveAiModelProfile(runtime, "adminChat")).toMatchObject({
      id: "adminChat",
      provider: "cloudflare",
      model: "google/gemini-3.5-flash",
    });
  });

  it("normalizes unknown and malformed model profiles safely", () => {
    const config = normalizeWidgetAiConfig({
      profiles: {
        adminChat: {
          enabled: true,
          provider: "not-a-provider",
          model: "gpt-5.4",
        },
        storefrontChat: "enabled",
        widgetGeneration: {
          enabled: true,
          provider: "gemini",
          model: 42,
        },
        imageGeneration: {
          enabled: true,
          provider: "openai",
          model: "x".repeat(201),
        },
        madeUpProfile: {
          enabled: true,
          provider: "openai",
          model: "gpt-5.4",
        },
      },
    });

    expect(Object.keys(config.profiles)).toEqual([...AI_MODEL_PROFILE_IDS]);
    expect("madeUpProfile" in config.profiles).toBe(false);
    expect(config.profiles.adminChat).toEqual({
      enabled: false,
      provider: "cloudflare",
      model: "gpt-5.4",
    });
    expect(config.profiles.storefrontChat).toEqual({
      enabled: false,
      provider: "cloudflare",
      model: "",
    });
    expect(config.profiles.widgetGeneration).toEqual({
      enabled: false,
      provider: "gemini",
      model: "",
    });
    expect(config.profiles.imageGeneration).toEqual({
      enabled: false,
      provider: "openai",
      model: "",
    });
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

  it("treats Cloudflare binding as valid credentials even when no REST key exists", () => {
    const runtime: WidgetAiRuntimeSettings = {
      ...DEFAULT_WIDGET_AI_CONFIG,
      apiKeys: {},
      credentialErrors: {},
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
      credentialErrors: {},
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

  it("accepts any well-formed Cloudflare catalog model ID without a local allowlist entry", () => {
    const runtime: WidgetAiRuntimeSettings = {
      ...DEFAULT_WIDGET_AI_CONFIG,
      apiKeys: {},
      credentialErrors: {},
      hasCloudflareBinding: true,
    };

    expect(
      requireAllowedWidgetAiModel(
        runtime,
        "cloudflare",
        "@cf/openai/gpt-oss-120b",
      ),
    ).toBe("@cf/openai/gpt-oss-120b");
    expect(
      requireAllowedWidgetAiModel(
        runtime,
        "cloudflare",
        "google/gemini-3.5-flash",
      ),
    ).toBe("google/gemini-3.5-flash");
    expect(
      requireAllowedWidgetAiModel(
        runtime,
        "cloudflare",
        "@google/gemini-3.5-flash",
      ),
    ).toBe("google/gemini-3.5-flash");
  });

  it("rejects malformed Cloudflare model IDs before provider dispatch", () => {
    const runtime: WidgetAiRuntimeSettings = {
      ...DEFAULT_WIDGET_AI_CONFIG,
      apiKeys: {},
      credentialErrors: {},
      hasCloudflareBinding: true,
    };

    expect(() =>
      requireAllowedWidgetAiModel(
        runtime,
        "cloudflare",
        "https://api.example/model",
      ),
    ).toThrow(ValidationError);
    expect(() =>
      requireAllowedWidgetAiModel(runtime, "cloudflare", "google"),
    ).toThrow(
      'AI model "google" is not a valid Cloudflare AI model ID.',
    );
  });

  it("rejects profile models that are outside the provider allowlist", () => {
    const runtime: WidgetAiRuntimeSettings = {
      ...DEFAULT_WIDGET_AI_CONFIG,
      providers: {
        ...DEFAULT_WIDGET_AI_CONFIG.providers,
        openai: {
          ...DEFAULT_WIDGET_AI_CONFIG.providers.openai,
          enabled: true,
          defaultModel: "gpt-5.4",
          allowedModels: ["gpt-5.4-mini"],
        },
      },
      profiles: {
        ...DEFAULT_WIDGET_AI_CONFIG.profiles,
        adminChat: {
          enabled: true,
          provider: "openai",
          model: "gpt-5.4-unapproved",
        },
      },
      apiKeys: { openai: "sk-prod-openai" },
      credentialErrors: {},
      hasCloudflareBinding: false,
    };

    expect(() => resolveAiModelProfile(runtime, "adminChat")).toThrow(
      'AI model "gpt-5.4-unapproved" is not enabled for openai.',
    );
  });

  it("resolves an enabled model profile through provider credentials and allowlist", () => {
    const runtime: WidgetAiRuntimeSettings = {
      ...DEFAULT_WIDGET_AI_CONFIG,
      providers: {
        ...DEFAULT_WIDGET_AI_CONFIG.providers,
        openai: {
          ...DEFAULT_WIDGET_AI_CONFIG.providers.openai,
          enabled: true,
          defaultModel: "gpt-5.4",
          allowedModels: ["gpt-5.4-mini"],
        },
      },
      profiles: {
        ...DEFAULT_WIDGET_AI_CONFIG.profiles,
        adminChat: {
          enabled: true,
          provider: "openai",
          model: "gpt-5.4-mini",
        },
      },
      apiKeys: { openai: "sk-prod-openai" },
      credentialErrors: {},
      hasCloudflareBinding: false,
    };

    expect(resolveAiModelProfile(runtime, "adminChat")).toMatchObject({
      id: "adminChat",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  it("preserves explicit widgetGeneration profile state on partial profile updates", async () => {
    const writes: Array<{ key: string; value: string; type?: string }> = [];
    const db = createWritableAiSettingsDb(
      [
        widgetAiConfigRow({
          activeProvider: "openai",
          providers: {
            openai: {
              enabled: true,
              defaultModel: "gpt-5.4",
              allowedModels: ["gpt-5.4-mini"],
            },
          },
          profiles: {
            widgetGeneration: {
              enabled: true,
              provider: "openai",
              model: "gpt-5.4-mini",
            },
            adminChat: {
              enabled: false,
              provider: "openai",
              model: "",
            },
          },
        }),
      ],
      writes,
    );

    await updateWidgetAiSettings(db as never, {
      profiles: {
        adminChat: {
          enabled: true,
          provider: "openai",
          model: "gpt-5.4",
        },
      },
    });

    const saved = writes.find((write) => write.key === "widget_generation_config");
    expect(saved).toBeDefined();
    const config = JSON.parse(saved?.value ?? "{}") as ReturnType<typeof normalizeWidgetAiConfig>;

    expect(config.profiles.widgetGeneration).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(config.profiles.adminChat).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-5.4",
    });
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
      credentialErrors: {},
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

  it("surfaces encrypted credential readiness errors when the credential key is missing", async () => {
    const key = credentialKey(12);
    const encrypted = await encryptCredentials("sk-prod-openai", key);
    const db = createAiSettingsDb([
      widgetAiConfigRow({
        activeProvider: "openai",
        providers: {
          openai: {
            enabled: true,
            defaultModel: "gpt-5.4",
          },
        },
      }),
      { key: "api_key_openai", value: encrypted },
    ]);

    const runtime = await getWidgetAiRuntimeSettings(db as never);
    const expectedError =
      "Widget AI OpenAI API key is encrypted but CREDENTIAL_ENCRYPTION_KEY is not configured.";

    expect(runtime.apiKeys.openai).toBeUndefined();
    expect(runtime.credentialErrors?.openai).toBe(expectedError);
    expect(getWidgetAiProviderCredentialError(runtime)).toBe(expectedError);
    expect(providerHasCredentials(runtime, runtime.activeProvider)).toBe(false);

    const adminSettings = await getWidgetAiAdminSettings(db as never);
    const serialized = JSON.stringify(adminSettings);

    expect(adminSettings.providers.openai.hasApiKey).toBe(false);
    expect(adminSettings.providers.openai.credentialError).toBe(expectedError);
    expect(adminSettings.credentialErrors.openai).toBe(expectedError);
    expect(serialized).not.toContain("sk-prod-openai");
    expect(serialized).not.toContain(encrypted);
  });

  it("surfaces encrypted credential decrypt failures without treating ciphertext as configured", async () => {
    const key = credentialKey(13);
    const wrongKey = credentialKey(14);
    const db = createAiSettingsDb([
      widgetAiConfigRow({
        activeProvider: "openai",
        providers: {
          openai: {
            enabled: true,
            defaultModel: "gpt-5.4",
          },
        },
      }),
      { key: "api_key_openai", value: await encryptCredentials("sk-prod-openai", key) },
    ]);

    const runtime = await getWidgetAiRuntimeSettings(db as never, {}, wrongKey);

    expect(runtime.apiKeys.openai).toBeUndefined();
    expect(runtime.credentialErrors?.openai).toBe(
      "Widget AI OpenAI API key could not be decrypted with the configured credential key.",
    );
    expect(providerHasCredentials(runtime, runtime.activeProvider)).toBe(false);
  });

  it("keeps legacy plaintext provider keys readable", async () => {
    const db = createAiSettingsDb([
      widgetAiConfigRow({
        activeProvider: "openrouter",
        providers: {
          openrouter: {
            enabled: true,
            defaultModel: "openai/gpt-5.4",
          },
        },
      }),
      { key: "api_key_openrouter", value: "sk-legacy-openrouter" },
    ]);

    const runtime = await getWidgetAiRuntimeSettings(db as never);

    expect(runtime.apiKeys.openrouter).toBe("sk-legacy-openrouter");
    expect(runtime.credentialErrors?.openrouter).toBeUndefined();
    expect(providerHasCredentials(runtime, runtime.activeProvider)).toBe(true);

    const adminSettings = await getWidgetAiAdminSettings(db as never);
    expect(adminSettings.providers.openrouter.hasApiKey).toBe(true);
    expect(adminSettings.providers.openrouter.credentialError).toBeUndefined();
    expect(JSON.stringify(adminSettings)).not.toContain("sk-legacy-openrouter");
  });
});
