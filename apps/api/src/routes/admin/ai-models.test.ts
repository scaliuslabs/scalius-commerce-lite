import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import {
  listAllowedModelsForProvider,
  listModelsForProvider,
} from "./ai-models";

function runtimeSettings(
  overrides: Partial<WidgetAiRuntimeSettings> = {},
): WidgetAiRuntimeSettings {
  return {
    ...DEFAULT_WIDGET_AI_CONFIG,
    providers: {
      ...DEFAULT_WIDGET_AI_CONFIG.providers,
      gemini: {
        ...DEFAULT_WIDGET_AI_CONFIG.providers.gemini,
        enabled: true,
        defaultModel: "gemini-2.5-pro",
        allowedModels: [],
      },
    },
    apiKeys: { gemini: "gemini-secret-key" },
    hasCloudflareBinding: false,
    ...overrides,
  };
}

describe("AI provider model catalog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists Gemini models with the API key in a header, not the URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: "models/gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              inputTokenLimit: 1_000_000,
              supportedGenerationMethods: ["generateContent"],
            },
          ],
          nextPageToken: "next-page",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: "models/text-embedding-004",
              displayName: "Text Embedding 004",
              supportedGenerationMethods: ["embedContent"],
            },
            {
              name: "models/gemini-2.5-flash",
              displayName: "Gemini 2.5 Flash",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const models = await listModelsForProvider("gemini", runtimeSettings());

    expect(models.map((model) => model.id)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("gemini-secret-key");
      expect(new URL(String(url)).searchParams.get("key")).toBeNull();
      expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(
        "gemini-secret-key",
      );
    }
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("pageToken=next-page");
  });

  it("falls back to the configured Gemini model without credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const models = await listModelsForProvider(
      "gemini",
      runtimeSettings({ apiKeys: {} }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(models).toEqual([
      expect.objectContaining({
        id: "gemini-2.5-pro",
        provider: "gemini",
        source: "configured",
      }),
    ]);
  });

  it("only exposes admin-enabled models to widget generation callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        models: [
          {
            name: "models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-2.5-flash-lite",
            displayName: "Gemini 2.5 Flash Lite",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await listAllowedModelsForProvider(
      "gemini",
      runtimeSettings({
        providers: {
          ...DEFAULT_WIDGET_AI_CONFIG.providers,
          gemini: {
            ...DEFAULT_WIDGET_AI_CONFIG.providers.gemini,
            enabled: true,
            defaultModel: "gemini-2.5-pro",
            allowedModels: ["gemini-2.5-flash"],
          },
        },
      }),
    );

    expect(models.map((model) => model.id)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });
});
