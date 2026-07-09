import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  ERROR_MESSAGES,
  type WidgetAiProvider,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import type { LanguageModel } from "ai";

function settingsFor(
  provider: WidgetAiProvider,
  options: { withCredentials?: boolean; cloudflareBinding?: boolean } = {},
): WidgetAiRuntimeSettings {
  const withCredentials = options.withCredentials ?? true;
  return {
    ...DEFAULT_WIDGET_AI_CONFIG,
    activeProvider: provider,
    providers: {
      ...DEFAULT_WIDGET_AI_CONFIG.providers,
      [provider]: {
        ...DEFAULT_WIDGET_AI_CONFIG.providers[provider],
        enabled: true,
        defaultModel: `${provider}-model`,
      },
    },
    apiKeys: withCredentials ? { [provider]: `${provider}-secret` } : {},
    hasCloudflareBinding: options.cloudflareBinding ?? false,
  };
}

describe("provider-neutral AI model runtime", () => {
  afterEach(() => {
    vi.doUnmock("@ai-sdk/openai");
    vi.doUnmock("@ai-sdk/google");
    vi.doUnmock("@openrouter/ai-sdk-provider");
    vi.doUnmock("workers-ai-provider");
    vi.resetModules();
  });

  it("fails closed before loading a provider client when credentials are missing", async () => {
    const createOpenAI = vi.fn();
    vi.doMock("@ai-sdk/openai", () => ({ createOpenAI }));
    const { createAiLanguageModel } = await import("./model-runtime");

    await expect(
      createAiLanguageModel(
        "openai",
        "gpt-test",
        settingsFor("openai", { withCredentials: false }),
        {} as Env,
      ),
    ).rejects.toThrow(ERROR_MESSAGES.apiKeyMissing);
    expect(createOpenAI).not.toHaveBeenCalled();
  });

  it.each([
    ["openrouter", "@openrouter/ai-sdk-provider", "createOpenRouter"],
    ["openai", "@ai-sdk/openai", "createOpenAI"],
    ["gemini", "@ai-sdk/google", "createGoogleGenerativeAI"],
  ] as const)(
    "selects only the %s adapter and returns its requested model",
    async (provider, moduleName, factoryName) => {
      const model = {
        provider,
        id: `${provider}-model`,
      } as unknown as LanguageModel;
      const modelFactory = vi.fn(() => model);
      const clientFactory = vi.fn(() => modelFactory);
      vi.doMock(moduleName, () => ({ [factoryName]: clientFactory }));
      const { createAiLanguageModel } = await import("./model-runtime");

      await expect(
        createAiLanguageModel(
          provider,
          `${provider}-model`,
          settingsFor(provider),
          {} as Env,
        ),
      ).resolves.toBe(model);
      expect(clientFactory).toHaveBeenCalledTimes(1);
      expect(modelFactory).toHaveBeenCalledWith(`${provider}-model`);
    },
  );

  it("selects the Cloudflare binding adapter without requiring a stored key", async () => {
    const model = {
      provider: "cloudflare",
      id: "cloudflare-model",
    } as unknown as LanguageModel;
    const modelFactory = vi.fn(() => model);
    const createWorkersAI = vi.fn(() => modelFactory);
    vi.doMock("workers-ai-provider", () => ({ createWorkersAI }));
    const { createAiLanguageModel } = await import("./model-runtime");
    const binding = { run: vi.fn() };

    await expect(
      createAiLanguageModel(
        "cloudflare",
        "cloudflare-model",
        settingsFor("cloudflare", {
          withCredentials: false,
          cloudflareBinding: true,
        }),
        { AI: binding } as unknown as Env,
      ),
    ).resolves.toBe(model);
    expect(createWorkersAI).toHaveBeenCalledWith({ binding });
    expect(modelFactory).toHaveBeenCalledWith("cloudflare-model");
  });
});
