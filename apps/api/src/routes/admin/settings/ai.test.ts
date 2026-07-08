import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getWidgetAiAdminSettings: vi.fn(),
  updateWidgetAiSettings: vi.fn(),
  getCredentialEncryptionKey: vi.fn(),
  requireEncryptionKey: vi.fn(),
}));

vi.mock("@scalius/core/modules/ai", () => ({
  AI_MODEL_PROFILE_IDS: [
    "adminChat",
    "storefrontChat",
    "widgetGeneration",
    "imageGeneration",
    "voice",
  ] as const,
  AI_PROVIDER_IDS: ["openrouter", "openai", "gemini", "cloudflare"] as const,
  getWidgetAiAdminSettings: mocks.getWidgetAiAdminSettings,
  updateWidgetAiSettings: mocks.updateWidgetAiSettings,
}));

vi.mock("../../../utils/encryption-key", () => ({
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
  requireEncryptionKey: mocks.requireEncryptionKey,
}));

import { aiSettingsRoutes } from "./ai";

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
  const env = { CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as unknown as Env;

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", { id: "db" } as never);
    await next();
  });
  app.route("/", aiSettingsRoutes);

  return { app, env };
}

async function postJson(app: OpenAPIHono<{ Bindings: Env }>, env: Env, body: unknown) {
  return app.request(
    "/api/v1/admin/settings/widget-ai",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("AI settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentialEncryptionKey.mockReturnValue("credential-key");
    mocks.requireEncryptionKey.mockReturnValue("credential-key");
    mocks.updateWidgetAiSettings.mockResolvedValue(undefined);
    mocks.getWidgetAiAdminSettings.mockResolvedValue({
      activeProvider: "cloudflare",
      providers: {},
      generation: {},
      prompts: {},
      defaultPrompts: {},
      credentialErrors: {},
      profiles: {
        adminChat: {
          enabled: true,
          provider: "openai",
          model: "gpt-4.1-mini",
        },
        widgetGeneration: {
          enabled: true,
          provider: "cloudflare",
          model: "@cf/moonshotai/kimi-k2.6",
        },
      },
    });
  });

  it("returns model profiles from the widget AI compatibility route", async () => {
    const { app, env } = createTestApp();

    const response = await app.request("/api/v1/admin/settings/widget-ai", { method: "GET" }, env);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as {
      success: boolean;
      data: {
        profiles?: Record<string, { enabled: boolean; provider: string; model: string }>;
      };
    };

    expect(body).toMatchObject({
      success: true,
      data: {
        profiles: {
          adminChat: {
            enabled: true,
            provider: "openai",
            model: "gpt-4.1-mini",
          },
          widgetGeneration: {
            enabled: true,
            provider: "cloudflare",
            model: "@cf/moonshotai/kimi-k2.6",
          },
        },
      },
    });
  });

  it("accepts non-secret model profile updates without requiring a secret write key", async () => {
    const { app, env } = createTestApp();
    const payload = {
      profiles: {
        adminChat: {
          enabled: true,
          provider: "openai",
          model: "gpt-4.1-mini",
        },
        storefrontChat: {
          enabled: false,
          provider: "gemini",
          model: "gemini-2.5-flash",
        },
      },
    };

    const response = await postJson(app, env, payload);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.updateWidgetAiSettings).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      payload,
      "credential-key",
    );
    expect(mocks.requireEncryptionKey).not.toHaveBeenCalled();
  });

  it("rejects secrets embedded inside model profiles", async () => {
    const { app, env } = createTestApp();

    const response = await postJson(app, env, {
      profiles: {
        adminChat: {
          enabled: true,
          provider: "openai",
          model: "gpt-4.1-mini",
          apiKey: "sk-live-secret",
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.updateWidgetAiSettings).not.toHaveBeenCalled();
  });

  it("rejects unsupported model profile keys", async () => {
    const { app, env } = createTestApp();

    const response = await postJson(app, env, {
      profiles: {
        checkoutChat: {
          enabled: true,
          provider: "openai",
          model: "gpt-4.1-mini",
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.updateWidgetAiSettings).not.toHaveBeenCalled();
  });

  it("rejects profile model IDs longer than 200 characters", async () => {
    const { app, env } = createTestApp();

    const response = await postJson(app, env, {
      profiles: {
        voice: {
          enabled: true,
          provider: "openai",
          model: "x".repeat(201),
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.updateWidgetAiSettings).not.toHaveBeenCalled();
  });
});
