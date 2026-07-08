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
  createWorkersAI: vi.fn(),
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

vi.mock("workers-ai-provider", () => ({
  createWorkersAI: mocks.createWorkersAI,
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

function cloudflareRuntimeSettings(model = "@cf/moonshotai/kimi-k2.6"): WidgetAiRuntimeSettings {
  return {
    ...DEFAULT_WIDGET_AI_CONFIG,
    providers: {
      ...DEFAULT_WIDGET_AI_CONFIG.providers,
      cloudflare: {
        ...DEFAULT_WIDGET_AI_CONFIG.providers.cloudflare,
        enabled: true,
        defaultModel: "@cf/moonshotai/kimi-k2.6",
      },
    },
    profiles: {
      ...DEFAULT_WIDGET_AI_CONFIG.profiles,
      adminChat: {
        enabled: true,
        provider: "cloudflare",
        model,
      },
    },
    apiKeys: {},
    credentialErrors: {},
    hasCloudflareBinding: true,
  };
}

function createTestApp(envOverrides: Partial<Env> = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = { id: "db" };
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    ...envOverrides,
  } as unknown as Env;

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

async function postChat(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(
    "/api/v1/admin/ai/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
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
    mocks.createWorkersAI.mockImplementation(() => vi.fn(() => ({ id: "workers-ai-model" } as unknown as LanguageModel)));
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
    expect(options.maxOutputTokens).toBe(2_000);
    expect(options.temperature).toBe(0.3);
    expect(options.tools).toBeUndefined();
    expect(options.messages[0]).toMatchObject({ role: "system" });

    const systemPrompt = options.messages[0]?.content ?? "";
    expect(systemPrompt.length).toBeLessThan(1_400);
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

  it("uses the Cloudflare Workers AI binding for the default adminChat profile without provider keys", async () => {
    const languageModel = { id: "cloudflare-admin-chat-model" } as unknown as LanguageModel;
    const workersAiModelFactory = vi.fn(() => languageModel);
    const aiBinding = { run: vi.fn() };
    mocks.getWidgetAiRuntimeSettings.mockResolvedValue(cloudflareRuntimeSettings());
    mocks.createWorkersAI.mockReturnValue(workersAiModelFactory);
    const { app, env } = createTestApp({ AI: aiBinding } as unknown as Partial<Env>);

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Can you help me find products?" }],
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.createWorkersAI).toHaveBeenCalledWith({ binding: aiBinding });
    expect(workersAiModelFactory).toHaveBeenCalledWith("@cf/moonshotai/kimi-k2.6");
    expect(mocks.createOpenAI).not.toHaveBeenCalled();

    const options = mocks.generateText.mock.calls[0]?.[0] as {
      model: LanguageModel;
    };
    expect(options.model).toBe(languageModel);

    const body = (await response.json()) as {
      success: true;
      data: {
        provider: string;
        model: string;
        message: { role: string; content: string };
      };
    };
    expect(body.data.provider).toBe("cloudflare");
    expect(body.data.model).toBe("@cf/moonshotai/kimi-k2.6");
    expect(JSON.stringify(body)).not.toMatch(/apiKey|secret|credential|sk-/i);
  });

  it("runs Cloudflare Gemini catalog models through the documented Worker binding schema", async () => {
    const aiBinding = {
      run: vi.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [{ text: "I can help improve the description." }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 40,
          candidatesTokenCount: 8,
          totalTokenCount: 48,
        },
      }),
    };
    mocks.getWidgetAiRuntimeSettings.mockResolvedValue(
      cloudflareRuntimeSettings("@google/gemini-3.5-flash"),
    );
    const { app, env } = createTestApp({ AI: aiBinding } as unknown as Partial<Env>);

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Can you improve a product description?" }],
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.createWorkersAI).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(aiBinding.run).toHaveBeenCalledTimes(1);
    expect(aiBinding.run).toHaveBeenCalledWith(
      "google/gemini-3.5-flash",
      expect.objectContaining({
        contents: [
          expect.objectContaining({
            role: "user",
            parts: [expect.objectContaining({ text: expect.stringContaining("Merchant:") })],
          }),
        ],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2400 },
        systemInstruction: {
          parts: [expect.objectContaining({ text: expect.stringContaining("admin assistant") })],
        },
      }),
    );

    const body = (await response.json()) as {
      success: true;
      data: {
        provider: string;
        model: string;
        message: { content: string };
        usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      };
    };
    expect(body.data.provider).toBe("cloudflare");
    expect(body.data.model).toBe("google/gemini-3.5-flash");
    expect(body.data.message.content).toBe("I can help improve the description.");
    expect(body.data.usage).toEqual({
      inputTokens: 40,
      outputTokens: 8,
      totalTokens: 48,
    });
  });

  it("returns a safe 503 when a Cloudflare Gemini catalog model fails", async () => {
    const aiBinding = {
      run: vi.fn().mockRejectedValue(new Error("model not found request abcdefghijklmnopqrstuvwxyz123456")),
    };
    mocks.getWidgetAiRuntimeSettings.mockResolvedValue(
      cloudflareRuntimeSettings("@google/gemini-3.5-flash"),
    );
    const { app, env } = createTestApp({ AI: aiBinding } as unknown as Partial<Env>);

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Say hello." }],
    });

    expect(response.status, await response.clone().text()).toBe(503);
    const body = (await response.json()) as {
      success: false;
      error: { message: string };
    };
    expect(body.error.message).toContain(
      'Cloudflare AI model "google/gemini-3.5-flash" failed.',
    );
    expect(body.error.message).toContain("[redacted-token]");
    expect(JSON.stringify(body)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("reads only admin_navigation_context through the Agent binding and returns catalog-derived actions", async () => {
    const agentCalls: Array<{
      input: string;
      method: string | undefined;
      headers: Headers;
      body: unknown;
    }> = [];
    const agentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const rpcBody = await new Response(init?.body).json();
      agentCalls.push({
        input: String(input),
        method: init?.method,
        headers,
        body: rpcBody,
      });
      if (
        typeof rpcBody === "object" &&
        rpcBody !== null &&
        "method" in rpcBody &&
        rpcBody.method === "initialize"
      ) {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: "admin-chat-navigation-initialize",
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "scalius-admin-agent", version: "0.1.0" },
            },
          },
          { headers: { "Mcp-Session-Id": "agent-session" } },
        );
      }

      return Response.json({
        jsonrpc: "2.0",
        id: "admin-chat-navigation-context",
        result: {
          structuredContent: {
            adminNavigationContext: {
              source: { permissions: "/api/v1/admin/rbac/my-permissions" },
              session: { userId: "admin_123", permissionCount: 10 },
              sections: [
                {
                  label: "Catalog",
                  pages: [
                    {
                      name: "Products",
                      path: "/admin/products",
                      requiredPermission: "products.view",
                    },
                    {
                      name: "Product detail",
                      path: "/admin/products/123",
                    },
                    {
                      name: "Unsafe external",
                      path: "https://evil.test/admin/products",
                    },
                  ],
                },
                {
                  label: "Sales",
                  pages: [{ name: "Orders", path: "/admin/orders" }],
                },
              ],
            },
          },
          content: [{ type: "text", text: "raw mcp output should not leak" }],
        },
      });
    });
    const { app, env } = createTestApp({ AGENT: { fetch: agentFetch } as Fetcher });

    const response = await postChat(
      app,
      env,
      {
        messages: [{ role: "user", content: "Please open products." }],
      },
      {
        Authorization: "Bearer should-not-forward",
        Cookie: "better-auth.session_token=session.signature",
        "User-Agent": "Mozilla/5.0 TestAgent",
        "X-Extra-Header": "drop-me",
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(agentFetch).toHaveBeenCalledTimes(2);
    for (const call of agentCalls) {
      expect(call.input).toBe("http://agent.internal/mcp/admin");
      expect(call.method).toBe("POST");
      expect(call.headers.get("cookie")).toBe(
        "better-auth.session_token=session.signature",
      );
      expect(call.headers.get("user-agent")).toBe("Mozilla/5.0 TestAgent");
      expect(call.headers.has("authorization")).toBe(false);
      expect(call.headers.has("x-extra-header")).toBe(false);
    }
    expect(agentCalls[1]?.headers.get("mcp-session-id")).toBe("agent-session");
    expect(agentCalls[1]?.headers.get("mcp-protocol-version")).toBe(
      "2025-06-18",
    );
    expect(
      agentCalls.map(({ body }) =>
        typeof body === "object" && body !== null && "method" in body
          ? body.method
          : null,
      ),
    ).toEqual(["initialize", "tools/call"]);
    expect(agentCalls[1]?.body).toEqual({
      jsonrpc: "2.0",
      id: "admin-chat-navigation-context",
      method: "tools/call",
      params: {
        name: "admin_navigation_context",
        arguments: {},
      },
    });
    expect(JSON.stringify(agentCalls.map(({ body }) => body))).toContain(
      "admin_navigation_context",
    );
    expect(JSON.stringify(agentCalls.map(({ body }) => body))).not.toContain(
      "tools/list",
    );
    expect(JSON.stringify(agentCalls.map(({ body }) => body))).not.toContain(
      "admin_product_search",
    );

    const options = mocks.generateText.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
    };
    expect(options.tools).toBeUndefined();
    const navContext = options.messages.find((message) =>
      message.content.includes("Allowed dashboard destinations"),
    )?.content;
    const systemPrompt = options.messages.find((message) =>
      message.content.includes("Scalius Commerce admin assistant"),
    )?.content;
    const actionContext = options.messages.find((message) =>
      message.content.includes("Click-confirmed navigation action"),
    )?.content;
    expect(systemPrompt).toContain("click-confirmed navigation button");
    expect(systemPrompt).not.toContain("you cannot navigate automatically");
    expect(navContext).toContain("Catalog > Products: /admin/products");
    expect(navContext).toContain("Sales > Orders: /admin/orders");
    expect(navContext).not.toContain("requiredPermission");
    expect(navContext).not.toContain("admin_123");
    expect(navContext).not.toContain("raw mcp output");
    expect(navContext).not.toContain("/admin/products/123");
    expect((navContext ?? "").length).toBeLessThanOrEqual(1_800);
    expect(actionContext).toContain("Open Products: /admin/products");
    expect(actionContext).toContain("use the visible action button");
    expect(actionContext).not.toContain("raw mcp output");

    const body = (await response.json()) as {
      success: true;
      data: {
        actions?: Array<{ type: string; path: string; label: string }>;
      };
    };
    expect(body.data.actions).toEqual([
      { type: "navigate", path: "/admin/products", label: "Open Products" },
    ]);
    expect(JSON.stringify(body)).not.toContain("raw mcp output");
  });

  it("adds bounded read-only product copy context for product description requests", async () => {
    const agentCalls: Array<{
      input: string;
      method: string | undefined;
      headers: Headers;
      body: unknown;
    }> = [];
    const agentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const rpcBody = await new Response(init?.body).json();
      agentCalls.push({
        input: String(input),
        method: init?.method,
        headers,
        body: rpcBody,
      });
      if (
        typeof rpcBody === "object" &&
        rpcBody !== null &&
        "method" in rpcBody &&
        rpcBody.method === "initialize"
      ) {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: "admin-chat-navigation-initialize",
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "scalius-admin-agent", version: "0.1.0" },
            },
          },
          { headers: { "Mcp-Session-Id": "agent-session" } },
        );
      }

      const toolName =
        typeof rpcBody === "object" &&
        rpcBody !== null &&
        "params" in rpcBody &&
        typeof (rpcBody as { params?: { name?: unknown } }).params?.name === "string"
          ? (rpcBody as { params: { name: string } }).params.name
          : "";

      if (toolName === "admin_navigation_context") {
        return Response.json({
          jsonrpc: "2.0",
          id: "admin-chat-navigation-context",
          result: {
            structuredContent: {
              adminNavigationContext: {
                sections: [{ label: "Catalog", pages: [{ name: "Products", path: "/admin/products" }] }],
              },
            },
          },
        });
      }

      if (toolName === "admin_product_search") {
        return Response.json({
          jsonrpc: "2.0",
          id: "admin-chat-product-search",
          result: {
            structuredContent: {
              adminProductSearch: {
                products: [{
                  id: "prod_iphone",
                  name: "iPhone 16",
                  slug: "iphone-16",
                  price: 120000,
                  sku: "SKU-SECRET",
                }],
              },
            },
            content: [{ type: "text", text: "raw search output must not leak" }],
          },
        });
      }

      if (toolName === "admin_product_copy_context") {
        return Response.json({
          jsonrpc: "2.0",
          id: "admin-chat-product-copy-context",
          result: {
            structuredContent: {
              adminProductCopyContext: {
                product: {
                  id: "prod_iphone",
                  name: "iPhone 16",
                  slug: "iphone-16",
                  route: "/products/iphone-16",
                  isActive: true,
                  categoryName: "Phones",
                  description: {
                    content:
                      "Flagship phone with excellent camera. Call 01775528888 or email buyer@example.com for private launch notes.",
                    excerpt: "Flagship phone with excellent camera.",
                  },
                  price: 120000,
                  sku: "SKU-SECRET",
                  stock: 99,
                  barcode: "BARCODE-SECRET",
                  primaryImage: "https://cdn.example.test/private.jpg",
                },
              },
            },
            content: [{ type: "text", text: "raw copy output must not leak" }],
          },
        });
      }

      return Response.json({ jsonrpc: "2.0", id: "unknown", result: { isError: true } });
    });
    const { app, env } = createTestApp({ AGENT: { fetch: agentFetch } as Fetcher });

    const response = await postChat(
      app,
      env,
      {
        messages: [
          {
            role: "user",
            content: "Can you improve our iPhone product's description?",
          },
        ],
      },
      {
        Authorization: "Bearer should-not-forward",
        Cookie: "better-auth.session_token=session.signature",
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(agentFetch).toHaveBeenCalledTimes(4);
    const toolNames = agentCalls
      .map(({ body }) =>
        typeof body === "object" &&
        body !== null &&
        "params" in body &&
        typeof (body as { params?: { name?: unknown } }).params?.name === "string"
          ? (body as { params: { name: string } }).params.name
          : null,
      )
      .filter(Boolean);
    expect(toolNames).toEqual([
      "admin_navigation_context",
      "admin_product_search",
      "admin_product_copy_context",
    ]);
    for (const call of agentCalls) {
      expect(call.headers.get("authorization")).toBeNull();
      if (call.body && typeof call.body === "object" && "method" in call.body && call.body.method !== "initialize") {
        expect(call.headers.get("mcp-session-id")).toBe("agent-session");
      }
    }
    expect(agentCalls[2]?.body).toMatchObject({
      params: {
        name: "admin_product_search",
        arguments: { query: "iPhone", limit: 2, page: 1 },
      },
    });
    expect(agentCalls[3]?.body).toMatchObject({
      params: {
        name: "admin_product_copy_context",
        arguments: { id: "prod_iphone" },
      },
    });

    const options = mocks.generateText.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
      maxOutputTokens?: number;
    };
    expect(options.maxOutputTokens).toBe(2_000);
    const copyContext = options.messages.find((message) =>
      message.content.includes("Read-only product copy context"),
    )?.content;
    expect(copyContext).toContain("Product: iPhone 16 (prod_iphone)");
    expect(copyContext).toContain("Current description:");
    expect(copyContext).toContain("Flagship phone with excellent camera.");
    expect(copyContext).toContain("[redacted-phone]");
    expect(copyContext).toContain("[redacted-email]");
    expect(copyContext).not.toContain("120000");
    expect(copyContext).not.toContain("SKU-SECRET");
    expect(copyContext).not.toContain("BARCODE-SECRET");
    expect(copyContext).not.toContain("private.jpg");
    expect(copyContext).not.toContain("raw copy output");
    expect(copyContext?.length ?? 0).toBeLessThanOrEqual(18_000);

    const body = (await response.json()) as {
      success: true;
      data: { message: { content: string } };
    };
    expect(body.data.message.content).toBe(
      "Open Settings, review the saved configuration, and save when ready.",
    );
  });

  it("prefers the current product edit route id before searching by product name", async () => {
    const agentCalls: Array<{ body: unknown }> = [];
    const agentFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rpcBody = await new Response(init?.body).json();
      agentCalls.push({ body: rpcBody });
      if (
        typeof rpcBody === "object" &&
        rpcBody !== null &&
        "method" in rpcBody &&
        rpcBody.method === "initialize"
      ) {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: "admin-chat-navigation-initialize",
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "scalius-admin-agent", version: "0.1.0" },
            },
          },
          { headers: { "Mcp-Session-Id": "agent-session" } },
        );
      }

      const toolName =
        typeof rpcBody === "object" &&
        rpcBody !== null &&
        "params" in rpcBody &&
        typeof (rpcBody as { params?: { name?: unknown } }).params?.name === "string"
          ? (rpcBody as { params: { name: string } }).params.name
          : "";

      if (toolName === "admin_navigation_context") {
        return Response.json({
          jsonrpc: "2.0",
          id: "admin-chat-navigation-context",
          result: {
            structuredContent: {
              adminNavigationContext: {
                sections: [{ label: "Catalog", pages: [{ name: "Products", path: "/admin/products" }] }],
              },
            },
          },
        });
      }

      if (toolName === "admin_product_copy_context") {
        return Response.json({
          jsonrpc: "2.0",
          id: "admin-chat-product-copy-context",
          result: {
            structuredContent: {
              adminProductCopyContext: {
                product: {
                  id: "prod_current",
                  name: "Current Product",
                  slug: "current-product",
                  route: "/products/current-product",
                  isActive: true,
                  description: {
                    content: "Current page product description.",
                    excerpt: "Current page product description.",
                  },
                },
              },
            },
            content: [{ type: "text", text: "Current product copy context." }],
          },
        });
      }

      throw new Error(`Unexpected tool ${toolName}`);
    });
    const { app, env } = createTestApp({ AGENT: { fetch: agentFetch } as Fetcher });

    const response = await postChat(app, env, {
      messages: [
        {
          role: "user",
          content:
            "Current safe dashboard context:\nRoute: /admin/products/prod_current\nHeading: Current Product",
        },
        {
          role: "user",
          content: "Improve this product description.",
        },
      ],
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const toolNames = agentCalls
      .map(({ body }) =>
        typeof body === "object" &&
        body !== null &&
        "params" in body &&
        typeof (body as { params?: { name?: unknown } }).params?.name === "string"
          ? (body as { params: { name: string } }).params.name
          : null,
      )
      .filter(Boolean);
    expect(toolNames).toEqual([
      "admin_navigation_context",
      "admin_product_copy_context",
    ]);
    expect(JSON.stringify(agentCalls.map(({ body }) => body))).not.toContain(
      "admin_product_search",
    );
    expect(agentCalls[2]?.body).toMatchObject({
      params: {
        name: "admin_product_copy_context",
        arguments: { id: "prod_current" },
      },
    });

    const options = mocks.generateText.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const copyContext = options.messages.find((message) =>
      message.content.includes("Read-only product copy context"),
    )?.content;
    expect(copyContext).toContain("Product: Current Product (prod_current)");
    expect(copyContext).toContain("Current page product description.");
  });

  it("fails soft without the Agent binding and still returns guidance-only chat", async () => {
    const { app, env } = createTestApp();

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Where do I manage products?" }],
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const options = mocks.generateText.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(
      options.messages.some((message) =>
        message.content.includes("Allowed dashboard destinations"),
      ),
    ).toBe(false);

    const body = (await response.json()) as {
      success: true;
      data: { message: { content: string }; actions?: unknown };
    };
    expect(body.data.message.content).toBe(
      "Open Settings, review the saved configuration, and save when ready.",
    );
    expect(body.data.actions).toBeUndefined();
  });
});
