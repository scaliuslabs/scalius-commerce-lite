import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import type { LanguageModel } from "ai";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getWidgetAiRuntimeSettings: vi.fn(),
  getCredentialEncryptionKey: vi.fn(),
  createOpenAI: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("@scalius/core/modules/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/ai")>();
  return {
    ...actual,
    getWidgetAiRuntimeSettings: mocks.getWidgetAiRuntimeSettings,
  };
});

vi.mock("../../utils/encryption-key", () => ({
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mocks.createOpenAI,
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  streamText: vi.fn(),
  Output: { object: vi.fn() },
}));

import { adminAiRoutes } from "./ai";

function runtimeSettings(
  overrides: {
    adminChatEnabled?: boolean;
    providerEnabled?: boolean;
    model?: string;
    maxOutputTokens?: number;
    planningTemperature?: number;
  } = {},
): WidgetAiRuntimeSettings {
  const model = overrides.model ?? "gpt-4.1-mini";
  return {
    ...DEFAULT_WIDGET_AI_CONFIG,
    activeProvider: "openai",
    providers: {
      ...DEFAULT_WIDGET_AI_CONFIG.providers,
      openai: {
        ...DEFAULT_WIDGET_AI_CONFIG.providers.openai,
        enabled: overrides.providerEnabled ?? true,
        defaultModel: model,
        allowedModels: [model],
      },
    },
    profiles: {
      ...DEFAULT_WIDGET_AI_CONFIG.profiles,
      adminChat: {
        enabled: overrides.adminChatEnabled ?? true,
        provider: "openai",
        model,
      },
    },
    generation: {
      ...DEFAULT_WIDGET_AI_CONFIG.generation,
      planningTemperature: overrides.planningTemperature ?? 0.7,
      maxOutputTokens: overrides.maxOutputTokens ?? 2_000,
    },
    apiKeys: { openai: "sk-test-secret" },
    credentialErrors: {},
    hasCloudflareBinding: false,
  };
}

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = { id: "db" };
  const env = { CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as unknown as Env;

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "admin_user" } as never);
    await next();
  });
  app.route("/admin/ai", adminAiRoutes);

  return { app, db, env };
}

async function postChat(app: OpenAPIHono<{ Bindings: Env }>, env: Env, body: unknown) {
  return app.request(
    "/api/v1/admin/ai/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("admin AI chat route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentialEncryptionKey.mockReturnValue("credential-key");
    mocks.getWidgetAiRuntimeSettings.mockResolvedValue(runtimeSettings());
    mocks.createOpenAI.mockImplementation(() => vi.fn(() => ({ id: "language-model" } as unknown as LanguageModel)));
    mocks.generateText.mockResolvedValue({
      text: "Open Settings, review the saved configuration, and save when ready.",
      totalUsage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
    });
  });

  it("fails closed when the adminChat profile is disabled", async () => {
    mocks.getWidgetAiRuntimeSettings.mockResolvedValue(runtimeSettings({ adminChatEnabled: false }));
    const { app, env } = createTestApp();

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Can you check my store settings?" }],
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as {
      success: false;
      error: { message: string };
    };
    expect(body.error.message).toBe('AI model profile "adminChat" is disabled.');
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("uses the adminChat profile model with a bounded read-only system prompt", async () => {
    const languageModel = { id: "admin-chat-model" } as unknown as LanguageModel;
    const openAiModelFactory = vi.fn(() => languageModel);
    mocks.createOpenAI.mockReturnValue(openAiModelFactory);
    const { app, env } = createTestApp();

    const response = await postChat(app, env, {
      messages: [
        { role: "user", content: "Can you update product inventory for me?" },
        { role: "assistant", content: "I can guide you through it." },
        { role: "user", content: "What should I do next?" },
      ],
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(openAiModelFactory).toHaveBeenCalledWith("gpt-4.1-mini");
    expect(mocks.generateText).toHaveBeenCalledTimes(1);

    const options = mocks.generateText.mock.calls[0]?.[0] as {
      model: LanguageModel;
      messages: Array<{ role: string; content: string }>;
      maxOutputTokens?: number;
      temperature?: number;
      tools?: unknown;
    };
    expect(options.model).toBe(languageModel);
    expect(options.maxOutputTokens).toBe(1_200);
    expect(options.temperature).toBe(0.3);
    expect(options.tools).toBeUndefined();
    expect(options.messages[0]).toMatchObject({ role: "system" });

    const systemPrompt = options.messages[0]?.content ?? "";
    expect(systemPrompt.length).toBeLessThan(1_200);
    expect(systemPrompt).toContain("cannot read live store data");
    expect(systemPrompt).toContain("mutate products");
    expect(systemPrompt).toContain("must perform it in the dashboard");
    expect(systemPrompt).not.toMatch(/\bMCP\b|service binding|bearer|cookie/i);
    expect(systemPrompt).not.toMatch(/can .*mutate|will .*mutate|use .*tool|call .*tool/i);

    const body = (await response.json()) as {
      success: true;
      data: {
        profile: string;
        provider: string;
        model: string;
        message: { role: string; content: string };
        usage: { totalTokens?: number };
      };
    };
    expect(body.data).toEqual({
      profile: "adminChat",
      provider: "openai",
      model: "gpt-4.1-mini",
      message: {
        role: "assistant",
        content: "Open Settings, review the saved configuration, and save when ready.",
      },
      usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
    });
    expect(JSON.stringify(body)).not.toContain("sk-test-secret");
  });
});
