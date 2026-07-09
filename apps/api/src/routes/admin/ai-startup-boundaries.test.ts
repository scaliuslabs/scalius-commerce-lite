import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import type { LanguageModel } from "ai";

function settingsWithProvider(
  provider: WidgetAiRuntimeSettings["activeProvider"],
): WidgetAiRuntimeSettings {
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
    apiKeys: {
      [provider]: `${provider}-secret`,
    },
    hasCloudflareBinding: false,
  };
}

describe("admin AI startup boundaries", () => {
  afterEach(() => {
    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
    vi.doUnmock("@ai-sdk/google");
    vi.doUnmock("@openrouter/ai-sdk-provider");
    vi.doUnmock("workers-ai-provider");
    vi.resetModules();
  });

  it("does not load the AI SDK or provider clients when the route module is imported", async () => {
    const loaded = {
      ai: false,
      openai: false,
      google: false,
      openrouter: false,
      workersai: false,
    };

    vi.doMock("ai", () => {
      loaded.ai = true;
      return {
        streamText: vi.fn(),
        generateText: vi.fn(),
        Output: { object: vi.fn() },
      };
    });
    vi.doMock("@ai-sdk/openai", () => {
      loaded.openai = true;
      return { createOpenAI: vi.fn() };
    });
    vi.doMock("@ai-sdk/google", () => {
      loaded.google = true;
      return { createGoogleGenerativeAI: vi.fn() };
    });
    vi.doMock("@openrouter/ai-sdk-provider", () => {
      loaded.openrouter = true;
      return { createOpenRouter: vi.fn() };
    });
    vi.doMock("workers-ai-provider", () => {
      loaded.workersai = true;
      return { createWorkersAI: vi.fn() };
    });

    await import("./ai");

    expect(loaded).toEqual({
      ai: false,
      openai: false,
      google: false,
      openrouter: false,
      workersai: false,
    });
  });

  it("loads the AI SDK only when streaming widget content is requested", async () => {
    let aiLoaded = false;
    const text = [
      "<htmljs>",
      '<section class="promo"><h2>Deal</h2></section>',
      "</htmljs>",
      "<css>",
      ".promo{padding:24px}",
      "</css>",
    ].join("\n");

    vi.doMock("ai", () => {
      aiLoaded = true;
      return {
        streamText: vi.fn(() => ({
          textStream: (async function* () {
            yield text;
          })(),
          text: Promise.resolve(text),
          totalUsage: Promise.resolve({
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
          }),
        })),
      };
    });

    const { streamWidgetContent } = await import("./ai");
    expect(aiLoaded).toBe(false);

    const options = {
      model: {} as LanguageModel,
      messages: [{ role: "user" as const, content: "Create a compact promo." }],
    } satisfies Parameters<typeof streamWidgetContent>[0];

    const stream = await streamWidgetContent(
      options,
      { supportsStructuredOutput: false },
      "widget",
    );
    expect(aiLoaded).toBe(true);

    let rawText = "";
    for await (const delta of stream.textStream) rawText += delta;

    const result = await stream.finalize(rawText);
    expect(result.text).toContain(
      '<section class="promo"><h2>Deal</h2></section>',
    );
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });

  it("loads only the selected provider client when resolving a language model", async () => {
    const loaded = {
      openai: false,
      google: false,
      openrouter: false,
      workersai: false,
    };
    const openaiModel = {} as LanguageModel;

    vi.doMock("@ai-sdk/openai", () => {
      loaded.openai = true;
      return { createOpenAI: vi.fn(() => vi.fn(() => openaiModel)) };
    });
    vi.doMock("@ai-sdk/google", () => {
      loaded.google = true;
      return { createGoogleGenerativeAI: vi.fn() };
    });
    vi.doMock("@openrouter/ai-sdk-provider", () => {
      loaded.openrouter = true;
      return { createOpenRouter: vi.fn() };
    });
    vi.doMock("workers-ai-provider", () => {
      loaded.workersai = true;
      return { createWorkersAI: vi.fn() };
    });

    const { createAiLanguageModel } =
      await import("../../modules/ai/model-runtime");
    expect(loaded).toEqual({
      openai: false,
      google: false,
      openrouter: false,
      workersai: false,
    });

    await expect(
      createAiLanguageModel(
        "openai",
        "openai-model",
        settingsWithProvider("openai"),
        {} as Env,
      ),
    ).resolves.toBe(openaiModel);

    expect(loaded).toEqual({
      openai: true,
      google: false,
      openrouter: false,
      workersai: false,
    });
  });
});
