import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import { RateLimitError } from "@scalius/core/errors";
import {
  STOREFRONT_CHAT_API_TIMEOUT_MS,
  STOREFRONT_CHAT_ANONYMOUS_RATE_LIMIT_BUCKET,
  STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER,
  STOREFRONT_CHAT_MODEL_TIMEOUT_MS,
} from "@scalius/shared/storefront-chat-boundary";
import { appendStorefrontAssistantCatalogReferences } from
  "@scalius/shared/storefront-assistant-references";
import type { LanguageModel } from "ai";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  getWidgetAiRuntimeSettings: vi.fn(),
  getCredentialEncryptionKey: vi.fn(),
  createOpenAI: vi.fn(),
  generateText: vi.fn(),
  consumeAssistantRateLimit: vi.fn(),
}));

vi.mock("@scalius/core/modules/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/ai")>();
  return {
    ...actual,
    getWidgetAiRuntimeSettings: mocks.getWidgetAiRuntimeSettings,
  };
});

vi.mock("../utils/encryption-key", () => ({
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
}));

vi.mock("@scalius/core/modules/assistant", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@scalius/core/modules/assistant")
  >();
  return {
    ...actual,
    consumeAssistantRateLimit: mocks.consumeAssistantRateLimit,
  };
});

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mocks.createOpenAI,
}));

vi.mock("workers-ai-provider", () => ({
  createWorkersAI: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  streamText: vi.fn(),
  Output: { object: vi.fn() },
}));

import {
  awaitStorefrontChatWork,
  storefrontChatRoutes,
} from "./storefront-chat";
import { parseJsonResponse } from "./storefront-chat-mcp";
import {
  createStorefrontNavigationActions,
  searchQueryFromMessages,
} from "./storefront-chat-navigation";

function runtimeSettings(
  overrides: {
    storefrontChatEnabled?: boolean;
    providerEnabled?: boolean;
    model?: string;
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
      storefrontChat: {
        enabled: overrides.storefrontChatEnabled ?? true,
        provider: "openai",
        model,
      },
    },
    generation: {
      ...DEFAULT_WIDGET_AI_CONFIG.generation,
      planningTemperature: 0.7,
      maxOutputTokens: 2_000,
    },
    apiKeys: { openai: "sk-test-secret" },
    credentialErrors: {},
    hasCloudflareBinding: false,
  };
}

function createTestApp(envOverrides: Partial<Env> = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = { id: "db" };
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    ASSISTANT_RATE_LIMIT_HMAC_KEY:
      "assistant-rate-limit-test-key-0123456789abcdef",
    STOREFRONT_URL: "https://storefront.example.test",
    ...envOverrides,
  } as unknown as Env;

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/storefront", storefrontChatRoutes);

  return { app, db, env };
}

async function postChat(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  body: unknown,
  headers: Record<string, string> = {},
  url = "http://api.internal/api/v1/storefront/chat",
) {
  return app.request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

function mcpEventResponse(body: Record<string, unknown>, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/event-stream");
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    ...init,
    headers,
  });
}

function createAgentFetch() {
  const calls: Array<{
    input: string;
    method: string | undefined;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = await new Response(init?.body).json() as Record<string, unknown>;
    calls.push({ input: String(input), method: init?.method, headers, body });

    if (body.method === "initialize") {
      return mcpEventResponse(
        {
          jsonrpc: "2.0",
          id: "storefront-chat-initialize",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "scalius-storefront-agent", version: "0.1.0" },
          },
        },
        { headers: { "Mcp-Session-Id": "agent-session" } },
      );
    }

    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    const params = body.params as { name?: string } | undefined;
    if (params?.name === "storefront_discovery_policy") {
      return mcpEventResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            storefrontDiscoveryPolicy: {
              discovery: {
                sitemap: { enabled: true },
                feeds: { productCatalogEnabled: true },
              },
              returnPolicy: { enabled: true, country: "BD", returnWindowDays: 7 },
              limits: {
                readOnly: true,
                canMutate: false,
                includesCustomerData: false,
                includesPaymentData: false,
                includesCheckoutData: false,
              },
              checkout: "must-not-leak",
              customerEmail: "buyer@example.test",
            },
          },
          content: [{ type: "text", text: "raw discovery output must not leak" }],
        },
      });
    }

    if (params?.name === "catalog_search") {
      return mcpEventResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            products: [
              {
                id: "prod_khaki",
                title: "Khaki Shoes",
                path: "/products/khaki-shoes",
                url: "https://storefront.example.test/products/khaki-shoes",
                checkoutUrl: "https://evil.example.test/checkout?token=sk_secret",
              },
            ],
          },
          content: [{ type: "text", text: "raw catalog output must not leak" }],
        },
      });
    }

    if (params?.name === "catalog_product") {
      return mcpEventResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            product: {
              id: "prod_rice",
              title: "Premium Rice",
              path: "/products/rice",
              availability: "in_stock",
            },
          },
          content: [{ type: "text", text: "raw product output must not leak" }],
        },
      });
    }

    if (params?.name === "catalog_lookup") {
      return mcpEventResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            products: [
              {
                id: "prod_rice",
                title: "Premium Rice",
                path: "/products/rice",
                availability: "in_stock",
              },
              {
                id: "prod_rice_gift",
                title: "Premium Rice Gift Box",
                path: "/products/rice-gift",
                availability: "in_stock",
              },
            ],
          },
          content: [{ type: "text", text: "raw lookup output must not leak" }],
        },
      });
    }

    if (params?.name === "cart_validate") {
      return mcpEventResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            cartValidation: {
              valid: false,
              issueCount: 1,
              issues: [{ code: "PRICE_CHANGED", message: "Unit price changed." }],
            },
          },
          content: [{ type: "text", text: "raw cart output must not leak" }],
        },
      });
    }

    throw new Error(`Unexpected storefront tool ${params?.name ?? "unknown"}`);
  });

  return { fetch, calls };
}

function authoritativeShoeProduct() {
  return {
    id: "gid://scalius/product/prod_khaki",
    title: "Khaki High-Top Casual Shoes For Mens",
    url:
      "https://storefront.example.test/products/khaki-high-top-casual-shoes-for-men",
    handle: "khaki-high-top-casual-shoes-for-men",
    price_range: {
      min: { amount: 4_104_000, currency: "BDT" },
      max: { amount: 4_104_000, currency: "BDT" },
    },
    options: [
      { name: "Size", values: [{ label: "42" }] },
      { name: "Color", values: [{ label: "Khaki" }] },
    ],
    variants: [{
      id: "gid://scalius/product-variant/var_khaki_42",
      title: "Khaki shoes - Size: 42 / Color: Khaki",
      price: { amount: 4_104_000, currency: "BDT" },
      availability: { available: true, status: "in_stock" },
      options: [
        { name: "Size", label: "42" },
        { name: "Color", label: "Khaki" },
      ],
      metadata: { variant_id: "var_khaki_42", available_quantity: 4 },
    }],
    media: [{
      type: "image",
      url: "https://cdn.example.test/khaki-shoes.jpg",
    }],
    metadata: { product_id: "prod_khaki", available_for_sale: true },
  };
}

function createAuthoritativeCatalogFetch() {
  const base = createAgentFetch();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const params = body.params as { name?: string } | undefined;
    if (params?.name === "catalog_search") {
      return mcpEventResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            ucp: { status: "success", version: "2026-04-08" },
            products: [authoritativeShoeProduct()],
            pagination: { total_count: 1 },
          },
        },
      });
    }
    if (params?.name === "catalog_product") {
      return mcpEventResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            ucp: { status: "success", version: "2026-04-08" },
            product: authoritativeShoeProduct(),
          },
        },
      });
    }
    return base.fetch(input, init);
  });
  return fetch;
}

function referencedProduct(id: string, title: string, handle: string) {
  const base = authoritativeShoeProduct();
  return {
    ...base,
    id,
    title,
    handle,
    url: `https://storefront.example.test/products/${handle}`,
    metadata: { product_id: id.split("/").at(-1), available_for_sale: true },
  };
}

function createReferencedCatalogFetch(products: Record<string, unknown>[]) {
  const base = createAgentFetch();
  const byId = new Map(products.map((product) => [String(product.id), product]));
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const params = body.params as {
      name?: string;
      arguments?: { id?: string; ids?: string[] };
    } | undefined;
    if (params?.name === "catalog_product") {
      return mcpEventResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            ucp: { status: "success", version: "2026-04-08" },
            product: byId.get(params.arguments?.id ?? "") ?? null,
          },
        },
      });
    }
    if (params?.name === "catalog_lookup") {
      return mcpEventResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            ucp: { status: "success", version: "2026-04-08" },
            products: (params.arguments?.ids ?? []).flatMap((id) => {
              const product = byId.get(id);
              return product ? [product] : [];
            }),
          },
        },
      });
    }
    return base.fetch(input, init);
  });
}

describe("storefront chat route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentialEncryptionKey.mockReturnValue("credential-key");
    mocks.getWidgetAiRuntimeSettings.mockResolvedValue(runtimeSettings());
    mocks.consumeAssistantRateLimit.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 19,
      resetAt: Date.now() + 60_000,
    });
    mocks.createOpenAI.mockImplementation(() => vi.fn(() => ({ id: "language-model" } as unknown as LanguageModel)));
    mocks.generateText.mockResolvedValue({
      text: "Khaki Shoes are a good match. Use /checkout?token=sk_secret or https://evil.example.test/admin to continue.",
      totalUsage: { inputTokens: 20, outputTokens: 16, totalTokens: 36 },
    });
  });

  it("bounds pre-model work with the API deadline signal", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = awaitStorefrontChatWork(
        new Promise<never>(() => {}),
        controller.signal,
      );
      const rejection = expect(pending).rejects.toThrow(
        "Storefront assistant request timed out",
      );
      setTimeout(() => controller.abort(), STOREFRONT_CHAT_API_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(STOREFRONT_CHAT_API_TIMEOUT_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the API deadline when settings prework never resolves", async () => {
    vi.useFakeTimers();
    try {
      mocks.getWidgetAiRuntimeSettings.mockImplementationOnce(
        () => new Promise<never>(() => {}),
      );
      const { fetch } = createAgentFetch();
      const { app, env } = createTestApp({
        STOREFRONT_AGENT: { fetch } as Fetcher,
      });
      const responsePromise = postChat(app, env, {
        messages: [{ role: "user", content: "Find shoes" }],
      });
      const assertion = responsePromise.then(async (response) => {
        expect(response.status, await response.clone().text()).toBe(503);
        expect(response.headers.get("cache-control")).toContain("no-store");
      });

      await vi.advanceTimersByTimeAsync(STOREFRONT_CHAT_API_TIMEOUT_MS);
      await assertion;
      expect(fetch).not.toHaveBeenCalled();
      expect(mocks.generateText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects the bounded SSE JSON-RPC response matching the request id", async () => {
    const expected = {
      jsonrpc: "2.0",
      id: "catalog-search-request",
      result: { structuredContent: { products: [{ id: "prod_rice" }] } },
    };
    const response = new Response(
      [
        "event: message",
        'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
        "",
        "event: message",
        'data: {"jsonrpc":"2.0","id":"catalog-search-request","method":"sampling/createMessage","params":{}}',
        "",
        "event: message",
        'data: {"jsonrpc":"2.0","id":"another-request","result":{"ignored":true}}',
        "",
        "event: message",
        `data: ${JSON.stringify(expected)}`,
        "",
      ].join("\n"),
      { headers: { "Content-Type": "text/event-stream" } },
    );

    await expect(
      parseJsonResponse(response, "catalog-search-request"),
    ).resolves.toEqual(expected);
  });

  it("extracts a bounded catalog term from a natural buyer question", () => {
    expect(searchQueryFromMessages([
      { role: "user", content: "Do you sell any shoes?" },
    ])).toBe("shoes");
    expect(searchQueryFromMessages([
      { role: "user", content: "Can you help me find khaki shoes?" },
    ])).toBe("khaki shoes");
    expect(searchQueryFromMessages([
      { role: "user", content: "What can I find here?" },
    ])).toBeNull();
    expect(searchQueryFromMessages([
      { role: "user", content: "How do I search the catalog?" },
    ])).toBeNull();
    expect(searchQueryFromMessages([
      { role: "user", content: "How can you help me shop?" },
    ])).toBeNull();
  });

  it("derives one authoritative category action for an exact category command", () => {
    const messages = [{
      role: "user" as const,
      content: "Take me to shoes category",
    }];
    expect(searchQueryFromMessages(messages)).toBe("shoes");
    expect(createStorefrontNavigationActions(
      { messages },
      [{
        tool: "catalog_categories",
        text: "verified categories",
        structuredContent: {
          catalogCategories: {
            categories: [
              {
                id: "cat_food",
                name: "Food",
                slug: "food",
                path: "/categories/food",
              },
              {
                id: "cat_shoes",
                name: "Shoes",
                slug: "shoes",
                path: "/categories/shoes",
              },
            ],
          },
        },
      }],
      "https://storefront.example.test",
    )).toEqual([{
      type: "navigate",
      path: "/categories/shoes",
      label: "Browse Shoes",
    }]);

    expect(createStorefrontNavigationActions(
      {
        messages: [{ role: "user", content: "Show me shoes" }],
      },
      [
        {
          tool: "catalog_search",
          text: "verified products",
          structuredContent: {
            products: [{
              id: "gid://scalius/product/prod_shoes",
              title: "Khaki Shoes",
              url: "https://storefront.example.test/products/khaki-shoes",
            }],
          },
        },
        {
          tool: "catalog_categories",
          text: "verified categories",
          structuredContent: {
            catalogCategories: {
              categories: [{
                id: "cat_shoes",
                name: "Shoes",
                slug: "shoes",
                path: "/categories/shoes",
              }],
            },
          },
        },
      ],
      "https://storefront.example.test",
    )).toEqual([{
      type: "navigate",
      path: "/search?q=shoes",
      label: "Search catalog",
    }]);
  });

  it("rejects an oversized MCP response before parsing", async () => {
    const response = new Response(new Uint8Array(600_000), {
      headers: { "Content-Type": "text/event-stream" },
    });

    await expect(parseJsonResponse(response, "bounded-request")).resolves
      .toBeNull();
  });

  it("requires the initialized notification acknowledgement before tool calls", async () => {
    const methods: unknown[] = [];
    const fetch = vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const body = await new Response(init?.body).json() as Record<
        string,
        unknown
      >;
      methods.push(body.method);
      if (body.method === "initialize") {
        return mcpEventResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-11-25" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 200 });
      }
      throw new Error("Tool call must not run before MCP initialization");
    });
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
    });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Find shoes" }],
    });

    expect(response.status, await response.clone().text()).toBe(503);
    expect(methods).toEqual(["initialize", "notifications/initialized"]);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("rejects direct public API requests before settings, Agent MCP, or model work", async () => {
    const { fetch } = createAgentFetch();
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
      ASSISTANT_RATE_LIMIT_HMAC_KEY: undefined as never,
    });

    const response = await postChat(
      app,
      env,
      {
        messages: [{ role: "user", content: "Find rice for buyer@example.test" }],
      },
      {
        [STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER]: "203.0.113.99",
      },
      "https://api.example.test/api/v1/storefront/chat",
    );

    expect(response.status, await response.clone().text()).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ success: false, error: "not_found" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.consumeAssistantRateLimit).not.toHaveBeenCalled();
    expect(mocks.getWidgetAiRuntimeSettings).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("requires only the dedicated rate-limit HMAC secret before D1, MCP, or model work", async () => {
    const { fetch } = createAgentFetch();
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
      ASSISTANT_RATE_LIMIT_HMAC_KEY: undefined as never,
      JWT_SECRET: "jwt-fallback-that-must-never-be-used-0123456789",
      CREDENTIAL_ENCRYPTION_KEY:
        "credential-fallback-that-must-never-be-used-0123456789",
    });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Can you help me find shoes?" }],
    });

    expect(response.status, await response.clone().text()).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message:
          "ASSISTANT_RATE_LIMIT_HMAC_KEY must contain at least 32 bytes.",
      },
    });
    expect(mocks.consumeAssistantRateLimit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.getWidgetAiRuntimeSettings).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("uses the D1 authority without reading or writing KV and hashes only a validated client bucket", async () => {
    const { fetch } = createAgentFetch();
    const kvGet = vi.fn();
    const kvPut = vi.fn();
    const { app, db, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
      CACHE: { get: kvGet, put: kvPut } as unknown as KVNamespace,
    });

    const response = await postChat(
      app,
      env,
      { messages: [{ role: "user", content: "Can you help?" }] },
      { [STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER]: "203.0.113.40" },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.consumeAssistantRateLimit).toHaveBeenCalledWith(db, {
      scope: "storefront.chat",
      bucket: "ipv4:203.0.113.40",
      hashKey: "assistant-rate-limit-test-key-0123456789abcdef",
      limit: 20,
      windowSeconds: 60,
    });
    expect(kvGet).not.toHaveBeenCalled();
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("maps malformed or PII-shaped internal identity headers to the conservative anonymous bucket", async () => {
    const { fetch } = createAgentFetch();
    const { app, db, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
    });

    const response = await postChat(
      app,
      env,
      { messages: [{ role: "user", content: "Can you help?" }] },
      { [STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER]: "buyer@example.test" },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.consumeAssistantRateLimit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        bucket: STOREFRONT_CHAT_ANONYMOUS_RATE_LIMIT_BUCKET,
      }),
    );
  });

  it("returns the atomic limit before settings, MCP, payload, or model work", async () => {
    mocks.consumeAssistantRateLimit.mockRejectedValueOnce(
      new RateLimitError("Assistant request limit reached.", 60),
    );
    const { fetch } = createAgentFetch();
    const { app, env } = createTestApp({ STOREFRONT_AGENT: { fetch } as Fetcher });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "buyer@example.test" }],
    });

    expect(response.status, await response.clone().text()).toBe(429);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.getWidgetAiRuntimeSettings).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("fails closed with no-store when the storefrontChat profile is disabled", async () => {
    mocks.getWidgetAiRuntimeSettings.mockResolvedValue(runtimeSettings({ storefrontChatEnabled: false }));
    const { app, env } = createTestApp();

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Can you help me find shoes?" }],
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json() as { success: false; error: { message: string } };
    expect(body.error.message).toBe('AI model profile "storefrontChat" is disabled.');
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("answers authoritative catalog search without waiting on the model", async () => {
    const fetch = createAuthoritativeCatalogFetch();
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
    });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Do you sell any shoes?" }],
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.generateText).not.toHaveBeenCalled();
    const body = await response.json() as {
      data: {
        message: { content: string; parts: Array<Record<string, unknown>> };
      };
    };
    expect(body.data.message.content).toContain(
      "Khaki High-Top Casual Shoes For Mens",
    );
    expect(body.data.message.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "product_grid" }),
    ]));
  });

  it("answers current product facts from MCP when visible metadata is stale", async () => {
    const fetch = createAuthoritativeCatalogFetch();
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
    });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "What am I looking at?" }],
      pageContext: {
        version: 1,
        contextVersion: 2,
        source: "storefront",
        page: {
          path: "/products/khaki-high-top-casual-shoes-for-men",
          title: "mhgvhgv",
          kind: "product",
        },
        surface: {
          kind: "product",
          productId: "prod_khaki",
          selectedOptions: [],
          displayedPrice: 1,
          availability: "selection_required",
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.generateText).not.toHaveBeenCalled();
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("Khaki High-Top Casual Shoes For Mens");
    expect(serialized).toContain("41,040.00");
    expect(serialized).toContain("Choose Size and Color");
    expect(serialized).not.toContain("mhgvhgv");
  });

  it("searches a named product target without option-axis terms and returns its options", async () => {
    const base = createAgentFetch();
    const runner = {
      ...authoritativeShoeProduct(),
      id: "gid://scalius/product/prod_runner",
      title: "Running Shoes",
      handle: "running-shoes",
      url: "https://storefront.example.test/products/running-shoes",
      options: [
        {
          name: "Size",
          values: [{ label: "40" }, { label: "41" }],
        },
        {
          name: "Color",
          values: [{ label: "Red" }, { label: "Blue" }],
        },
      ],
      metadata: { product_id: "prod_runner", available_for_sale: true },
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const params = body.params as { name?: string } | undefined;
      if (params?.name === "catalog_search") {
        return mcpEventResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: {
              ucp: { status: "success", version: "2026-04-08" },
              products: [runner],
              pagination: { total_count: 1 },
            },
          },
        });
      }
      return base.fetch(input, init);
    });
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
    });

    const response = await postChat(app, env, {
      messages: [{
        role: "user",
        content: "What colors are available in running shoes?",
      }],
      pageContext: {
        page: { path: "/products/khaki-shoes", kind: "product" },
        surface: {
          kind: "product",
          productId: "prod_khaki",
          selectedOptions: [],
          displayedPrice: 1,
          availability: "selection_required",
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.generateText).not.toHaveBeenCalled();
    const searchCall = fetch.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(String(init?.body)) as {
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      return body.params?.name === "catalog_search" ? [body.params] : [];
    });
    expect(searchCall).toEqual([{
      name: "catalog_search",
      arguments: { query: "running shoes", limit: 5 },
    }]);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("Running Shoes");
    expect(serialized).toContain("Color: Red, Blue");
    expect(serialized).not.toContain("Size: 40, 41");
    expect(serialized).not.toContain("colors running shoes");
  });

  it("falls back to catalog facts when recommendation generation fails", async () => {
    const fetch = createAuthoritativeCatalogFetch();
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
    });
    mocks.generateText.mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Recommend shoes for travel" }],
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("Khaki High-Top Casual Shoes For Mens");
    expect(serialized).toContain("product_grid");
    expect(serialized).not.toContain("provider unavailable");
    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      timeout: { totalMs: STOREFRONT_CHAT_MODEL_TIMEOUT_MS },
    }));
  });

  it("resolves the same second catalog reference before and after replay", async () => {
    const firstId = "gid://scalius/product/prod_first";
    const secondId = "gid://scalius/product/prod_second";
    const fetch = createReferencedCatalogFetch([
      referencedProduct(firstId, "First Shoes", "first-shoes"),
      referencedProduct(secondId, "Second Shoes", "second-shoes"),
    ]);
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
    });
    const assistantHistory = appendStorefrontAssistantCatalogReferences(
      "I found two current matches.",
      [firstId, secondId],
      2_000,
    );
    const requestBody = {
      messages: [
        { role: "assistant", content: assistantHistory },
        { role: "user", content: "Tell me about the second one" },
      ],
      pageContext: {
        page: { path: "/products/unrelated", kind: "product" },
        surface: {
          kind: "product",
          productId: "prod_unrelated",
          selectedOptions: [{ name: "Size", label: "M" }],
          displayedPrice: 1,
          availability: "in_stock",
        },
      },
    };

    for (const source of ["live history", "replayed history"]) {
      const response = await postChat(app, env, requestBody);
      expect(response.status, `${source}: ${await response.clone().text()}`)
        .toBe(200);
      const serialized = JSON.stringify(await response.json());
      expect(serialized, source).toContain("Second Shoes");
      expect(serialized, source).not.toContain("First Shoes");
    }

    expect(mocks.generateText).not.toHaveBeenCalled();
    const toolCalls = fetch.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(String(init?.body)) as {
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      return body.params?.name ? [body.params] : [];
    });
    expect(toolCalls.filter((call) => call.name === "catalog_product"))
      .toEqual([
        { name: "catalog_product", arguments: { id: secondId } },
        { name: "catalog_product", arguments: { id: secondId } },
      ]);
    expect(toolCalls.some((call) => call.name === "catalog_search")).toBe(false);
  });

  it("fails a removed multi-ordinal reference closed without model or navigation", async () => {
    const firstId = "gid://scalius/product/prod_first";
    const secondId = "gid://scalius/product/prod_second";
    const removedId = "gid://scalius/product/prod_removed";
    const fetch = createReferencedCatalogFetch([
      referencedProduct(firstId, "First Shoes", "first-shoes"),
      referencedProduct(secondId, "Second Shoes", "second-shoes"),
    ]);
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
    });
    const assistantHistory = appendStorefrontAssistantCatalogReferences(
      "I found three current matches.",
      [firstId, secondId, removedId],
      2_000,
    );

    const response = await postChat(app, env, {
      messages: [
        { role: "assistant", content: assistantHistory },
        { role: "user", content: "Compare first and third" },
      ],
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.generateText).not.toHaveBeenCalled();
    const body = await response.json() as {
      data: { message: { content: string }; actions?: unknown };
    };
    expect(body.data.message.content).toContain(
      "can’t resolve every referenced item",
    );
    expect(body.data.actions).toBeUndefined();
  });

  it("calls only public Agent MCP tools without cookies/auth and returns safe click-confirmed navigation", async () => {
    const { fetch, calls } = createAgentFetch();
    const { app, env } = createTestApp({ STOREFRONT_AGENT: { fetch } as Fetcher });

    const response = await postChat(
      app,
      env,
      {
        messages: [{ role: "user", content: "Can you check my cart availability and find khaki shoes?" }],
        pageContext: {
          version: 1,
          contextVersion: 2,
          source: "storefront",
          page: { path: "/cart", title: "Cart", kind: "cart" },
          cart: {
            totalItems: 2,
            lineCount: 1,
            subtotalAmount: 200,
            lines: [
              {
                lineKey: "line:v2:prod_khaki:variant:var_42",
                productId: "prod_khaki",
                variantId: "var_42",
                slug: "khaki-shoes",
                name: "Khaki Shoes",
                quantity: 2,
                unitPrice: 100,
                lineTotal: 200,
                options: [{ name: "Size", label: "42" }],
              },
            ],
            hasDiscount: true,
            truncated: false,
          },
          surface: {
            kind: "cart",
            revision: 7,
            fingerprint: "cart_v1_deadbeef",
            exactLineKeys: ["line:v2:prod_khaki:variant:var_42"],
            totalItems: 2,
            lineCount: 1,
          },
        },
      },
      {
        Authorization: "Bearer should-not-forward",
        Cookie: "cs_tok=customer-session; better-auth.session_token=admin-session",
        "X-Extra-Header": "drop-me",
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetch).toHaveBeenCalledTimes(5);
    for (const call of calls) {
      expect(call.input).toBe("http://storefront-agent.internal/mcp");
      expect(call.method).toBe("POST");
      expect(call.headers.get("accept")).toBe(
        "application/json, text/event-stream",
      );
      expect(call.headers.get("cookie")).toBeNull();
      expect(call.headers.get("authorization")).toBeNull();
      expect(call.headers.get("x-extra-header")).toBeNull();
    }
    for (const call of calls.slice(1)) {
      expect(call.headers.get("mcp-session-id")).toBe("agent-session");
      expect(call.headers.get("mcp-protocol-version")).toBe("2025-11-25");
    }
    expect(calls.map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
      "tools/call",
    ]);
    expect(calls[1]?.body).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(calls.map((call) => (call.body.params as { name?: string } | undefined)?.name).filter(Boolean)).toEqual([
      "storefront_discovery_policy",
      "catalog_search",
      "cart_validate",
    ]);
    expect(calls[4]?.body).toMatchObject({
      params: {
        name: "cart_validate",
        arguments: {
          items: [
            {
              productId: "prod_khaki",
              variantId: "var_42",
              slug: "khaki-shoes",
              name: "Khaki Shoes",
              quantity: 2,
              unitPrice: 100,
              options: [{ name: "Size", value: "42" }],
            },
          ],
        },
      },
    });

    const options = mocks.generateText.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
      maxOutputTokens?: number;
      temperature?: number;
    };
    expect(options.tools).toBeUndefined();
    expect(options.maxOutputTokens).toBe(1_200);
    expect(options.temperature).toBe(0.3);
    const serializedPrompt = JSON.stringify(options.messages);
    expect(serializedPrompt).toContain("storefront catalog assistant");
    expect(serializedPrompt).toContain("storefront_discovery_policy");
    expect(serializedPrompt).toContain("catalog_search");
    expect(serializedPrompt).toContain("cart_validate");
    expect(serializedPrompt).toContain("Cart revision: 7");
    expect(serializedPrompt).toContain("Cart fingerprint: cart_v1_deadbeef");
    expect(serializedPrompt).toContain("line:v2:prod_khaki:variant:var_42");
    expect(serializedPrompt).toContain("PRICE_CHANGED");
    expect(serializedPrompt).not.toContain("raw catalog output");
    expect(serializedPrompt).not.toContain("raw discovery output");
    expect(serializedPrompt).not.toContain("must-not-leak");
    expect(serializedPrompt).not.toContain("buyer@example.test");
    expect(serializedPrompt).not.toContain("sk-test-secret");

    const body = await response.json() as {
      success: true;
      data: {
        profile: string;
        provider: string;
        model: string;
        message: { role: string; content: string };
        usage: { totalTokens?: number };
        actions?: Array<{ type: string; path: string; label: string }>;
      };
    };
    expect(body.data).toMatchObject({
      profile: "storefrontChat",
      provider: "openai",
      model: "gpt-4.1-mini",
      usage: { inputTokens: 20, outputTokens: 16, totalTokens: 36 },
      actions: [{
        type: "navigate",
        path: "/search?q=khaki+shoes",
        label: "Search catalog",
      }],
    });
    expect(body.data.message.content).toContain("Khaki Shoes are a good match");
    expect(body.data.message.content).toContain("[unsupported navigation target]");
    expect(JSON.stringify(body)).not.toContain("/checkout");
    expect(JSON.stringify(body)).not.toContain("evil.example.test");
    expect(JSON.stringify(body)).not.toContain("sk_secret");
  });

  it("re-sanitizes messages and cart display context before Agent MCP or model orchestration", async () => {
    const { fetch, calls } = createAgentFetch();
    const { app, env } = createTestApp({ STOREFRONT_AGENT: { fetch } as Fetcher });
    mocks.generateText.mockResolvedValue({
      text: "The cart needs a safe availability review.",
      totalUsage: {},
    });

    const response = await postChat(app, env, {
      messages: [
        {
          role: "user",
          content: "Check my cart for buyer@example.test 01711111111 chk_private_receipt",
        },
      ],
      pageContext: {
        version: 1,
        source: "storefront",
        page: {
          path: "/cart",
          route: "/cart",
          canonicalUrl: "https://storefront.example.test/cart?token=chk_private_receipt",
          title: "Cart for buyer@example.test",
          kind: "cart",
        },
        cart: {
          totalItems: 1,
          lineCount: 1,
          subtotalAmount: 100,
          lines: [
            {
              productId: "prod_rice",
              variantId: "var_pack",
              slug: "rice",
              name: "Rice for 01711111111",
              quantity: 1,
              unitPrice: 100,
              options: [{ name: "Recipient", label: "Bearer private-session-token" }],
            },
          ],
          hasDiscount: false,
          truncated: false,
        },
        surface: {
          kind: "product",
          productId: "prod_private_surface",
          selectedOptions: [],
          displayedPrice: 100,
          availability: "in_stock",
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const downstream = JSON.stringify({
      agentCalls: calls.map((call) => call.body),
      modelMessages: (mocks.generateText.mock.calls[0]?.[0] as {
        messages?: unknown;
      })?.messages,
    });
    expect(downstream).toContain("[redacted-email]");
    expect(downstream).toContain("[redacted-phone]");
    expect(downstream).toContain("[redacted-token]");
    expect(downstream).not.toContain("buyer@example.test");
    expect(downstream).not.toContain("01711111111");
    expect(downstream).not.toContain("chk_private_receipt");
    expect(downstream).not.toContain("private-session-token");
    expect(downstream).not.toContain("prod_private_surface");
  });

  it("uses registered product surface identity for authoritative MCP lookup", async () => {
    const { fetch, calls } = createAgentFetch();
    const { app, env } = createTestApp({ STOREFRONT_AGENT: { fetch } as Fetcher });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Tell me about this product" }],
      pageContext: {
        version: 1,
        contextVersion: 2,
        source: "storefront",
        page: { path: "/products/rice", title: "Rice", kind: "product" },
        surface: {
          kind: "product",
          productId: "prod_rice",
          slug: "rice",
          selectedVariantId: "var_2kg",
          selectedOptions: [{ name: "Weight", label: "2KG" }],
          displayedPrice: 850,
          availability: "in_stock",
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const productCall = calls.find(
      (call) =>
        (call.body.params as { name?: string } | undefined)?.name ===
        "catalog_product",
    );
    expect(productCall?.body).toMatchObject({
      params: {
        name: "catalog_product",
        arguments: {
          id: "var_2kg",
          selected: [{ name: "Weight", label: "2KG" }],
        },
      },
    });
    expect(mocks.generateText).not.toHaveBeenCalled();
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("Premium Rice");
    expect(serialized).toContain("Weight: 2KG");
  });

  it("uses bounded search surface query and listing facts for MCP and model context", async () => {
    const { fetch, calls } = createAgentFetch();
    const { app, env } = createTestApp({ STOREFRONT_AGENT: { fetch } as Fetcher });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "What about these?" }],
      pageContext: {
        version: 1,
        contextVersion: 2,
        source: "storefront",
        page: { path: "/search", title: "Search", kind: "search" },
        surface: {
          kind: "search",
          query: "premium rice",
          visibleProductIds: ["prod_rice", "prod_rice_gift"],
          visibleFilters: [{ key: "brand", value: "Scalius" }],
          totalResults: 2,
          page: 1,
          sortBy: "price-asc",
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const searchCall = calls.find(
      (call) =>
        (call.body.params as { name?: string } | undefined)?.name ===
        "catalog_search",
    );
    expect(searchCall?.body).toMatchObject({
      params: {
        name: "catalog_search",
        arguments: { query: "premium rice", limit: 5 },
      },
    });
    const visibleLookupCall = calls.find(
      (call) =>
        (call.body.params as { name?: string } | undefined)?.name ===
        "catalog_lookup",
    );
    expect(visibleLookupCall?.body).toMatchObject({
      params: {
        name: "catalog_lookup",
        arguments: { ids: ["prod_rice", "prod_rice_gift"] },
      },
    });
    const prompt = JSON.stringify(
      (mocks.generateText.mock.calls[0]?.[0] as { messages?: unknown })?.messages,
    );
    expect(prompt).toContain("Search query: premium rice");
    expect(prompt).toContain("Visible filters: brand=Scalius");
    expect(prompt).toContain("Visible product IDs: prod_rice, prod_rice_gift");
    expect(prompt).toContain("Premium Rice Gift Box");
  });

  it("bounds listing lookups to the first five buyer-visible product ids", async () => {
    const { fetch, calls } = createAgentFetch();
    const { app, env } = createTestApp({
      STOREFRONT_AGENT: { fetch } as Fetcher,
    });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Help me choose" }],
      pageContext: {
        version: 1,
        contextVersion: 2,
        source: "storefront",
        page: {
          path: "/categories/food",
          title: "Food",
          kind: "category",
        },
        surface: {
          kind: "category",
          categoryId: "cat_food",
          slug: "food",
          visibleProductIds: [
            "prod_1",
            "prod_2",
            "prod_3",
            "prod_4",
            "prod_5",
            "prod_6",
          ],
          visibleFilters: [],
          totalResults: 6,
          page: 1,
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const visibleLookupCall = calls.find(
      (call) =>
        (call.body.params as { name?: string } | undefined)?.name ===
        "catalog_lookup",
    );
    expect(visibleLookupCall?.body).toMatchObject({
      params: {
        name: "catalog_lookup",
        arguments: {
          ids: ["prod_1", "prod_2", "prod_3", "prod_4", "prod_5"],
        },
      },
    });
    expect(JSON.stringify(visibleLookupCall?.body)).not.toContain("prod_6");
    expect(calls.some(
      (call) =>
        (call.body.params as { name?: string } | undefined)?.name ===
        "catalog_search",
    )).toBe(false);
  });

  it("drops PII-shaped product surface fields again at the API boundary", async () => {
    const { fetch, calls } = createAgentFetch();
    const { app, env } = createTestApp({ STOREFRONT_AGENT: { fetch } as Fetcher });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Tell me about this product" }],
      pageContext: {
        version: 1,
        contextVersion: 2,
        source: "storefront",
        page: { path: "/products/rice", title: "Rice", kind: "product" },
        surface: {
          kind: "product",
          productId: "prod_rice",
          slug: "rice",
          selectedVariantId: "buyer@example.test",
          selectedOptions: [
            { name: "Recipient", label: "01711111111" },
            { name: "Weight", label: "2KG" },
          ],
          displayedPrice: 850,
          availability: "in_stock",
          customerEmail: "buyer@example.test",
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.generateText).not.toHaveBeenCalled();
    const downstream = JSON.stringify({
      calls: calls.map((call) => call.body),
      response: await response.json(),
    });
    expect(downstream).toContain("prod_rice");
    expect(downstream).toContain("Weight: 2KG");
    expect(downstream).not.toContain("buyer@example.test");
    expect(downstream).not.toContain("01711111111");
    expect(downstream).not.toContain("Recipient");
  });

  it("rejects oversized v2 surface fields before MCP or model work", async () => {
    const { fetch } = createAgentFetch();
    const { app, env } = createTestApp({ STOREFRONT_AGENT: { fetch } as Fetcher });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Tell me about this product" }],
      pageContext: {
        version: 1,
        contextVersion: 2,
        source: "storefront",
        page: { path: "/products/rice", kind: "product" },
        surface: {
          kind: "product",
          productId: `prod_${"x".repeat(130)}`,
          selectedOptions: [],
          displayedPrice: 850,
          availability: "in_stock",
        },
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("reduces sensitive-page context and conversation to a fixed generic-help marker", async () => {
    const { fetch, calls } = createAgentFetch();
    const { app, env } = createTestApp({ STOREFRONT_AGENT: { fetch } as Fetcher });
    mocks.generateText.mockResolvedValue({ text: "Use the visible account controls.", totalUsage: {} });

    const response = await postChat(app, env, {
      messages: [
        {
          role: "assistant",
          content: "Earlier details mentioned Ayesha Rahman near Dhanmondi Lake.",
        },
        {
          role: "user",
          content: "My name is Ayesha Rahman. I live at 17 Lake View Road in Dhanmondi, Dhaka. Leave it beside the blue gate.",
        },
      ],
      pageContext: {
        version: 1,
        source: "storefront",
        page: {
          path: "/account/orders/private-order-id",
          route: "/account/orders/[id]",
          canonicalUrl: "https://storefront.example.test/account/orders/private-order-id",
          title: "Private account order",
          kind: "product",
        },
        cart: {
          totalItems: 1,
          lineCount: 1,
          subtotalAmount: 100,
          lines: [
            {
              productId: "prod_private",
              name: "Private cart item",
              quantity: 1,
              unitPrice: 100,
            },
          ],
          hasDiscount: true,
          truncated: false,
        },
        surface: {
          kind: "product",
          productId: "prod_private_surface",
          selectedOptions: [],
          displayedPrice: 100,
          availability: "in_stock",
        },
      },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const modelMessages = JSON.stringify(
      (mocks.generateText.mock.calls[0]?.[0] as { messages?: unknown })?.messages,
    );
    expect(modelMessages).toContain("Page kind: account");
    expect(modelMessages).toContain("requested general help while viewing a sensitive account page");
    expect(modelMessages).not.toContain("Ayesha Rahman");
    expect(modelMessages).not.toContain("17 Lake View Road");
    expect(modelMessages).not.toContain("Dhanmondi");
    expect(modelMessages).not.toContain("Dhaka");
    expect(modelMessages).not.toContain("blue gate");
    expect(modelMessages).not.toContain("private-order-id");
    expect(modelMessages).not.toContain("Private account order");
    expect(modelMessages).not.toContain("Private cart item");
    expect(modelMessages).not.toContain("Cart summary:");
    expect(modelMessages).not.toContain("prod_private_surface");
    expect(calls.map((call) => (call.body.params as { name?: string } | undefined)?.name).filter(Boolean)).toEqual([
      "storefront_discovery_policy",
    ]);
    const agentPayloads = JSON.stringify(calls.map((call) => call.body));
    expect(agentPayloads).not.toContain("Ayesha Rahman");
    expect(agentPayloads).not.toContain("17 Lake View Road");
    expect(agentPayloads).not.toContain("Dhanmondi");
    expect(agentPayloads).not.toContain("blue gate");
  });

  it("strips unsafe navigation candidates instead of returning actions", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Response(init?.body).json() as Record<string, unknown>;
      calls.push(body);
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-11-25" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const params = body.params as { name?: string } | undefined;
      if (params?.name === "storefront_discovery_policy") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { structuredContent: { storefrontDiscoveryPolicy: { limits: { readOnly: true } } } },
        });
      }
      if (params?.name === "catalog_search") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: {
              products: [
                { title: "Unsafe", path: "/checkout?token=sk_live_secret" },
                { title: "External", url: "https://evil.example.test/products/unsafe" },
                { title: "Traversal", path: "/products/../admin" },
                { title: "Token Path", path: "/products/sk_live_secret" },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected tool ${params?.name ?? "unknown"}`);
    });
    mocks.generateText.mockResolvedValue({
      text: "I can help with public product browsing.",
      totalUsage: {},
    });
    const { app, env } = createTestApp({ STOREFRONT_AGENT: { fetch } as Fetcher });

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Tell me about shoes" }],
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(calls.map((body) => (body.params as { name?: string } | undefined)?.name).filter(Boolean)).toEqual([
      "storefront_discovery_policy",
      "catalog_search",
    ]);
    const body = await response.json() as { success: true; data: { actions?: unknown } };
    expect(body.data.actions).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("/checkout");
    expect(JSON.stringify(body)).not.toContain("evil.example.test");
    expect(JSON.stringify(body)).not.toContain("sk_live_secret");
  });

  it("fails closed when the Agent service binding is unavailable", async () => {
    const { app, env } = createTestApp();

    const response = await postChat(app, env, {
      messages: [{ role: "user", content: "Find khaki shoes" }],
    });

    expect(response.status, await response.clone().text()).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json() as { success: false; error: { message: string } };
    expect(body.error.message).toBe("Storefront assistant catalog tools are temporarily unavailable.");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
