import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  enforceGeneratedImageGenerationLimit: vi.fn(),
  recordGeneratedImagePreview: vi.fn(),
  saveGeneratedImagePreview: vi.fn(),
  resolveAiModelProfile: vi.fn(),
  generateAiImage: vi.fn(),
  loadAiRuntimeSettings: vi.fn(),
  enforceAiRateLimit: vi.fn(),
}));

vi.mock("@scalius/core/modules/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/media")>()),
  enforceGeneratedImageGenerationLimit:
    mocks.enforceGeneratedImageGenerationLimit,
  recordGeneratedImagePreview: mocks.recordGeneratedImagePreview,
  saveGeneratedImagePreview: mocks.saveGeneratedImagePreview,
}));

vi.mock("@scalius/core/modules/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/ai")>()),
  resolveAiModelProfile: mocks.resolveAiModelProfile,
}));

vi.mock("../../modules/ai/image-runtime", () => ({
  generateAiImage: mocks.generateAiImage,
}));

vi.mock("../../modules/ai/model-runtime", () => ({
  loadAiRuntimeSettings: mocks.loadAiRuntimeSettings,
}));

vi.mock("./ai-rate-limit", () => ({
  enforceAiRateLimit: mocks.enforceAiRateLimit,
}));

import { adminMediaRoutes } from "./media";

function testApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath(
    "/api/v1/admin/media",
  );
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", { id: "db" } as never);
    c.set("user", {
      id: "admin_1",
      name: "Admin",
      email: "admin@example.test",
    });
    await next();
  });
  app.route("/", adminMediaRoutes);
  return app;
}

describe("Admin generated media routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAiRuntimeSettings.mockResolvedValue({ id: "settings" });
    mocks.resolveAiModelProfile.mockReturnValue({
      provider: "cloudflare",
      model: "@cf/black-forest-labs/flux-2-dev",
    });
    mocks.generateAiImage.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    });
    mocks.recordGeneratedImagePreview.mockResolvedValue({
      id: "aig_abcdefghijklmnop",
      provider: "cloudflare",
      model: "@cf/black-forest-labs/flux-2-dev",
      promptHash: "a".repeat(64),
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      cost: { status: "not_reported" },
      expiresAt: new Date("2026-07-10T12:15:00.000Z"),
    });
  });

  it("uses the saved image profile and returns one no-store binary preview", async () => {
    const prompt = "Premium studio shoe photograph";
    const response = await testApp().request(
      "/api/v1/admin/media/image-generation/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, aspectRatio: "1:1" }),
      },
      { AI: { run: vi.fn() } } as unknown as Env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-scalius-generation-id")).toBe(
      "aig_abcdefghijklmnop",
    );
    expect(response.headers.get("x-scalius-generation-total-tokens")).toBe(
      "10",
    );
    expect(response.headers.get("x-scalius-generation-cost-status")).toBe(
      "not_reported",
    );
    expect([...response.headers.values()].join(" ")).not.toContain(prompt);
    expect(mocks.enforceGeneratedImageGenerationLimit).toHaveBeenCalledOnce();
    expect(mocks.generateAiImage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "cloudflare",
        modelId: "@cf/black-forest-labs/flux-2-dev",
        prompt,
        aspectRatio: "1:1",
      }),
    );
  });

  it("saves the exact multipart preview through server-side fingerprint authority", async () => {
    const saved = {
      id: "media_1",
      filename: "generated.png",
      url: "https://cdn.test/generated.png",
      size: 3,
      mimeType: "image/png",
      folderId: null,
      sourceType: "ai_generated",
      generationId: "aig_abcdefghijklmnop",
      generationProvider: "cloudflare",
      generationModel: "@cf/black-forest-labs/flux-2-dev",
      generationPromptHash: "a".repeat(64),
      generationInputTokens: 3,
      generationOutputTokens: 7,
      generationTotalTokens: 10,
      generationCostUsdMicros: null,
      generationCostStatus: "not_reported",
      generatedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    mocks.saveGeneratedImagePreview.mockResolvedValue(saved);
    const body = new FormData();
    body.append("generationId", "aig_abcdefghijklmnop");
    body.append("altText", "Black shoe");
    body.append(
      "file",
      new File([new Uint8Array([1, 2, 3])], "preview.png", {
        type: "image/png",
      }),
    );

    const response = await testApp().request(
      "/api/v1/admin/media/image-generation/save",
      { method: "POST", body },
      {} as Env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { file: { id: "media_1", sourceType: "ai_generated" } },
    });
    expect(mocks.saveGeneratedImagePreview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      expect.objectContaining({
        generationId: "aig_abcdefghijklmnop",
        userId: "admin_1",
        altText: "Black shoe",
        file: expect.any(File),
      }),
    );
  });
});
