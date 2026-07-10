import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  ERROR_MESSAGES,
  type WidgetAiProvider,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import type { ImageModel } from "ai";

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
        defaultModel: `${provider}-image-model`,
      },
    },
    apiKeys: withCredentials ? { [provider]: `${provider}-secret` } : {},
    hasCloudflareBinding: options.cloudflareBinding ?? false,
  };
}

describe("provider-neutral image runtime", () => {
  afterEach(() => {
    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
    vi.doUnmock("@ai-sdk/google");
    vi.doUnmock("workers-ai-provider");
    vi.resetModules();
  });

  it.each([
    ["openai", "@ai-sdk/openai", "createOpenAI"],
    ["gemini", "@ai-sdk/google", "createGoogleGenerativeAI"],
  ] as const)("selects the exact %s image adapter", async (
    provider,
    moduleName,
    factoryName,
  ) => {
    const model = { provider, modelId: `${provider}-image-model` } as ImageModel;
    const imageModel = vi.fn(() => model);
    const factory = vi.fn(() => ({ imageModel }));
    vi.doMock(moduleName, () => ({ [factoryName]: factory }));
    const { createAiImageModel } = await import("./image-runtime");

    await expect(createAiImageModel(
      provider,
      `${provider}-image-model`,
      settingsFor(provider),
      {} as Env,
    )).resolves.toBe(model);
    expect(imageModel).toHaveBeenCalledWith(`${provider}-image-model`);
  });

  it("uses the Cloudflare binding without a stored credential", async () => {
    const model = { provider: "cloudflare" } as ImageModel;
    const imageModel = vi.fn(() => model);
    const createWorkersAI = vi.fn(() => ({ imageModel }));
    vi.doMock("workers-ai-provider", () => ({ createWorkersAI }));
    const binding = { run: vi.fn() };
    const { createAiImageModel } = await import("./image-runtime");

    await expect(createAiImageModel(
      "cloudflare",
      "@cf/test-image",
      settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      { AI: binding } as unknown as Env,
    )).resolves.toBe(model);
    expect(createWorkersAI).toHaveBeenCalledWith({ binding });
    expect(imageModel).toHaveBeenCalledWith("@cf/test-image");
  });

  it("fails before loading an adapter when credentials are unavailable", async () => {
    const createOpenAI = vi.fn();
    vi.doMock("@ai-sdk/openai", () => ({ createOpenAI }));
    const { createAiImageModel } = await import("./image-runtime");

    await expect(createAiImageModel(
      "openai",
      "gpt-image-test",
      settingsFor("openai", { withCredentials: false }),
      {} as Env,
    )).rejects.toThrow(ERROR_MESSAGES.apiKeyMissing);
    expect(createOpenAI).not.toHaveBeenCalled();
  });

  it("generates one bounded image without retries", async () => {
    const model = { provider: "openai" } as ImageModel;
    const imageModel = vi.fn(() => model);
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: vi.fn(() => ({ imageModel })),
    }));
    const generateImage = vi.fn().mockResolvedValue({
      image: {
        mediaType: "image/png",
        uint8Array: new Uint8Array([1, 2, 3]),
      },
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    });
    vi.doMock("ai", () => ({ generateImage }));
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "openai",
      modelId: "gpt-image-test",
      settings: settingsFor("openai"),
      env: {} as Env,
      prompt: "A clean product photograph on a neutral background",
      aspectRatio: "1:1",
    })).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    });
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      model,
      n: 1,
      maxRetries: 0,
      aspectRatio: "1:1",
      abortSignal: expect.any(AbortSignal),
    }));
  });

  it("never leaks provider construction or generation details", async () => {
    const secret = "buyer@example.test Bearer sk-private-image-prompt";
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: vi.fn(() => {
        throw new Error(secret);
      }),
    }));
    const { createAiImageModel } = await import("./image-runtime");

    let caught: unknown;
    try {
      await createAiImageModel(
        "openai",
        "gpt-image-test",
        settingsFor("openai"),
        {} as Env,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "AiImageGenerationError",
      message: "Image generation is temporarily unavailable.",
    });
    expect(JSON.stringify(caught)).not.toContain("buyer@example.test");
    expect((caught as Error).message).not.toContain("sk-private-image-prompt");
  });
});
