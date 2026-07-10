import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WIDGET_AI_CONFIG,
  ERROR_MESSAGES,
  type ImageGenerationProvider,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import type { ImageModel } from "ai";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(
  atob(PNG_BASE64),
  (character) => character.charCodeAt(0),
);
const IMAGE_MODELS = {
  openai: "gpt-image-1",
  gemini: "imagen-4.0-generate-001",
  cloudflare: "google/nano-banana-2",
} as const;

function settingsFor(
  provider: ImageGenerationProvider,
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
        defaultModel: IMAGE_MODELS[provider],
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
    vi.unstubAllGlobals();
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
    const model = { provider, modelId: IMAGE_MODELS[provider] } as ImageModel;
    const imageModel = vi.fn(() => model);
    const factory = vi.fn(() => ({ imageModel }));
    vi.doMock(moduleName, () => ({ [factoryName]: factory }));
    const { createAiImageModel } = await import("./image-runtime");

    await expect(createAiImageModel(
      provider,
      IMAGE_MODELS[provider],
      settingsFor(provider),
      {} as Env,
    )).resolves.toBe(model);
    expect(imageModel).toHaveBeenCalledWith(IMAGE_MODELS[provider]);
  });

  it("runs a unified Cloudflare Google model directly and downloads its documented HTTPS result", async () => {
    const imageUrl = "https://images.example.test/generated.png";
    const binding = {
      run: vi.fn().mockResolvedValue({
        gatewayMetadata: { keySource: "Unified" },
        result: { image: imageUrl },
        state: "Completed",
      }),
    };
    const fetchImage = vi.fn().mockResolvedValue(
      new Response(PNG_BYTES, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(PNG_BYTES.byteLength),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchImage);
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId: "@google/nano-banana-2",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A premium product photograph",
      aspectRatio: "16:9",
    })).resolves.toEqual({
      bytes: PNG_BYTES,
      mediaType: "image/png",
      usage: {},
    });
    expect(binding.run).toHaveBeenCalledWith(
      "google/nano-banana-2",
      {
        prompt: "A premium product photograph",
        aspect_ratio: "16:9",
        output_format: "png",
      },
      {
        gateway: { id: "default" },
        signal: expect.any(AbortSignal),
      },
    );
    expect(fetchImage).toHaveBeenCalledWith(
      imageUrl,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("maps native Flux 2 aspect ratio to its documented multipart dimensions", async () => {
    const binding = { run: vi.fn().mockResolvedValue({ image: PNG_BASE64 }) };
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId: "@cf/black-forest-labs/flux-2-dev",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A portrait product photograph",
      aspectRatio: "4:5",
    })).resolves.toMatchObject({
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    const call = binding.run.mock.calls[0];
    expect(call?.[0]).toBe("@cf/black-forest-labs/flux-2-dev");
    expect(call?.[2]).toEqual({ signal: expect.any(AbortSignal) });
    const multipart = (call?.[1] as {
      multipart: { body: ReadableStream<Uint8Array>; contentType: string };
    }).multipart;
    const form = await new Response(multipart.body, {
      headers: { "Content-Type": multipart.contentType },
    }).formData();
    expect(Object.fromEntries(form.entries())).toEqual({
      prompt: "A portrait product photograph",
      width: "768",
      height: "960",
    });
  });

  it("uses exact dimensions for native stream models and validates their bytes", async () => {
    const binding = {
      run: vi.fn().mockResolvedValue(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PNG_BYTES);
            controller.close();
          },
        }),
      ),
    };
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId: "@cf/bytedance/stable-diffusion-xl-lightning",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A landscape product photograph",
      aspectRatio: "3:2",
      seed: 42,
    })).resolves.toMatchObject({
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    expect(binding.run).toHaveBeenCalledWith(
      "@cf/bytedance/stable-diffusion-xl-lightning",
      {
        prompt: "A landscape product photograph",
        width: 1152,
        height: 768,
        seed: 42,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("decodes only the documented bounded native base64 image field", async () => {
    const binding = { run: vi.fn().mockResolvedValue({ image: PNG_BASE64 }) };
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId: "@cf/black-forest-labs/flux-1-schnell",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A product photograph",
    })).resolves.toMatchObject({
      bytes: PNG_BYTES,
      mediaType: "image/png",
    });
    expect(binding.run).toHaveBeenCalledWith(
      "@cf/black-forest-labs/flux-1-schnell",
      { prompt: "A product photograph" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    { seed: 7, prompt: "A product photograph", message: "Seed is not supported" },
    {
      seed: undefined,
      prompt: "x".repeat(2_049),
      message: "up to 2,048 characters",
    },
  ])("rejects unsupported Flux 1 controls before binding work", async ({
    seed,
    prompt,
    message,
  }) => {
    const binding = { run: vi.fn() };
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId: "@cf/black-forest-labs/flux-1-schnell",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt,
      ...(seed === undefined ? {} : { seed }),
    })).rejects.toThrow(message);
    expect(binding.run).not.toHaveBeenCalled();
  });

  it("fails closed when the actual Cloudflare binding is missing", async () => {
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId: "google/nano-banana-2",
      settings: settingsFor("cloudflare", {
        withCredentials: true,
        cloudflareBinding: true,
      }),
      env: {} as Env,
      prompt: "A product photograph",
    })).rejects.toThrow("requires the Workers AI binding");
  });

  it("maps an exact unified OpenAI portrait ratio to its documented size", async () => {
    const binding = {
      run: vi.fn().mockResolvedValue({
        gatewayMetadata: { keySource: "Unified" },
        result: { image: "https://images.example.test/generated.png" },
        state: "Completed",
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(PNG_BYTES, {
        headers: { "Content-Type": "image/png" },
      }),
    ));
    const { generateAiImage } = await import("./image-runtime");

    await generateAiImage({
      provider: "cloudflare",
      modelId: "openai/gpt-image-2",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A portrait product photograph",
      aspectRatio: "2:3",
    });

    expect(binding.run).toHaveBeenCalledWith(
      "openai/gpt-image-2",
      {
        prompt: "A portrait product photograph",
        size: "1024x1536",
        output_format: "png",
      },
      {
        gateway: { id: "default" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("uses Imagen 4's exact schema without inventing an output format", async () => {
    const binding = {
      run: vi.fn().mockResolvedValue({
        gatewayMetadata: { keySource: "Unified" },
        result: { image: "https://images.example.test/generated.png" },
        state: "Completed",
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(PNG_BYTES, {
        headers: { "Content-Type": "image/png" },
      }),
    ));
    const { generateAiImage } = await import("./image-runtime");

    await generateAiImage({
      provider: "cloudflare",
      modelId: "google/imagen-4",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A wide product photograph",
      aspectRatio: "16:9",
    });

    expect(binding.run).toHaveBeenCalledWith(
      "google/imagen-4",
      {
        prompt: "A wide product photograph",
        aspect_ratio: "16:9",
      },
      {
        gateway: { id: "default" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it.each([
    "google/nano-banana-2-lite",
    "@cf/black-forest-labs/flux-future",
    "OpenAI/GPT-IMAGE-2",
  ])("rejects unreviewed Cloudflare image schema %s", async (modelId) => {
    const binding = { run: vi.fn() };
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId,
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A product photograph",
    })).rejects.toThrow("does not support image generation");
    expect(binding.run).not.toHaveBeenCalled();
  });

  it("fails clearly instead of changing an unsupported unified OpenAI ratio", async () => {
    const binding = { run: vi.fn() };
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId: "openai/gpt-image-1.5",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A wide product photograph",
      aspectRatio: "16:9",
    })).rejects.toThrow(
      "Use provider default or 1:1",
    );
    expect(binding.run).not.toHaveBeenCalled();
  });

  it("uses GPT Image 1.5's exact square schema without output_format", async () => {
    const binding = {
      run: vi.fn().mockResolvedValue({
        gatewayMetadata: { keySource: "Unified" },
        result: { image: "https://images.example.test/generated.png" },
        state: "Completed",
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(PNG_BYTES, {
        headers: { "Content-Type": "image/png" },
      }),
    ));
    const { generateAiImage } = await import("./image-runtime");

    await generateAiImage({
      provider: "cloudflare",
      modelId: "openai/gpt-image-1.5",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A square product photograph",
      aspectRatio: "1:1",
    });

    expect(binding.run).toHaveBeenCalledWith(
      "openai/gpt-image-1.5",
      { prompt: "A square product photograph", size: "1024x1024" },
      {
        gateway: { id: "default" },
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("rejects an undocumented unified envelope before downloading anything", async () => {
    const binding = {
      run: vi.fn().mockResolvedValue({
        gatewayMetadata: { keySource: "Unified" },
        result: { image: "https://images.example.test/generated.png" },
        state: "Completed",
        unexpected: true,
      }),
    };
    const fetchImage = vi.fn();
    vi.stubGlobal("fetch", fetchImage);
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId: "google/nano-banana-2",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A product photograph",
    })).rejects.toMatchObject({ name: "AiImageGenerationError" });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("rejects an oversized unified download before buffering its body", async () => {
    const binding = {
      run: vi.fn().mockResolvedValue({
        gatewayMetadata: { keySource: "Unified" },
        result: { image: "https://images.example.test/generated.png" },
        state: "Completed",
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(PNG_BYTES, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(10 * 1024 * 1024 + 1),
        },
      }),
    ));
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "cloudflare",
      modelId: "google/nano-banana-2",
      settings: settingsFor("cloudflare", {
        withCredentials: false,
        cloudflareBinding: true,
      }),
      env: { AI: binding } as unknown as Env,
      prompt: "A product photograph",
    })).rejects.toMatchObject({ name: "AiImageGenerationError" });
  });

  it("fails before loading an adapter when credentials are unavailable", async () => {
    const createOpenAI = vi.fn();
    vi.doMock("@ai-sdk/openai", () => ({ createOpenAI }));
    const { createAiImageModel } = await import("./image-runtime");

    await expect(createAiImageModel(
      "openai",
      "gpt-image-1",
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
        uint8Array: PNG_BYTES,
      },
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    });
    vi.doMock("ai", () => ({ generateImage }));
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "openai",
      modelId: "gpt-image-1",
      settings: settingsFor("openai"),
      env: {} as Env,
      prompt: "A clean product photograph on a neutral background",
      aspectRatio: "2:3",
    })).resolves.toEqual({
      bytes: PNG_BYTES,
      mediaType: "image/png",
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    });
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      model,
      n: 1,
      maxRetries: 0,
      size: "1024x1536",
      abortSignal: expect.any(AbortSignal),
    }));
    expect(generateImage.mock.calls[0]?.[0]).not.toHaveProperty("aspectRatio");
  });

  it("rejects an OpenAI ratio without an exact provider size", async () => {
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: vi.fn(() => ({ imageModel: vi.fn(() => ({ provider: "openai" })) })),
    }));
    const generateImage = vi.fn();
    vi.doMock("ai", () => ({ generateImage }));
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "openai",
      modelId: "gpt-image-1",
      settings: settingsFor("openai"),
      env: {} as Env,
      prompt: "A product photograph",
      aspectRatio: "4:5",
    })).rejects.toThrow("does not have an exact size");
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("keeps Gemini aspect ratios as provider-native aspect ratios", async () => {
    const model = { provider: "gemini" } as ImageModel;
    vi.doMock("@ai-sdk/google", () => ({
      createGoogleGenerativeAI: vi.fn(() => ({ imageModel: vi.fn(() => model) })),
    }));
    const generateImage = vi.fn().mockResolvedValue({
      image: { mediaType: "image/png", uint8Array: PNG_BYTES },
      usage: {},
    });
    vi.doMock("ai", () => ({ generateImage }));
    const { generateAiImage } = await import("./image-runtime");

    await generateAiImage({
      provider: "gemini",
      modelId: "imagen-4.0-generate-001",
      settings: settingsFor("gemini"),
      env: {} as Env,
      prompt: "A square product photograph",
      aspectRatio: "1:1",
    });

    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      model,
      aspectRatio: "1:1",
    }));
  });

  it.each([
    { aspectRatio: "2:3" as const, seed: undefined, message: "aspect ratio" },
    { aspectRatio: undefined, seed: 5, message: "Seed is not supported" },
  ])("rejects unsupported Imagen controls instead of accepting SDK warnings", async ({
    aspectRatio,
    seed,
    message,
  }) => {
    vi.doMock("@ai-sdk/google", () => ({
      createGoogleGenerativeAI: vi.fn(() => ({
        imageModel: vi.fn(() => ({ provider: "gemini" })),
      })),
    }));
    const generateImage = vi.fn();
    vi.doMock("ai", () => ({ generateImage }));
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "gemini",
      modelId: "imagen-4.0-generate-001",
      settings: settingsFor("gemini"),
      env: {} as Env,
      prompt: "A product photograph",
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(seed === undefined ? {} : { seed }),
    })).rejects.toThrow(message);
    expect(generateImage).not.toHaveBeenCalled();
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

  it("rejects non-raster provider output before it reaches media storage", async () => {
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: vi.fn(() => ({ imageModel: vi.fn(() => ({ provider: "openai" })) })),
    }));
    vi.doMock("ai", () => ({
      generateImage: vi.fn().mockResolvedValue({
        image: {
          mediaType: "image/svg+xml",
          uint8Array: new Uint8Array([60, 115, 118, 103, 62]),
        },
        usage: {},
      }),
    }));
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "openai",
      modelId: "gpt-image-test",
      settings: settingsFor("openai"),
      env: {} as Env,
      prompt: "A raster product photo",
    })).rejects.toMatchObject({
      name: "AiImageGenerationError",
      message: "Image generation is temporarily unavailable.",
    });
  });

  it("rejects arbitrary bytes even when the provider declares PNG", async () => {
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: vi.fn(() => ({ imageModel: vi.fn(() => ({ provider: "openai" })) })),
    }));
    vi.doMock("ai", () => ({
      generateImage: vi.fn().mockResolvedValue({
        image: {
          mediaType: "image/png",
          uint8Array: new Uint8Array([1, 2, 3]),
        },
        usage: {},
      }),
    }));
    const { generateAiImage } = await import("./image-runtime");

    await expect(generateAiImage({
      provider: "openai",
      modelId: "gpt-image-test",
      settings: settingsFor("openai"),
      env: {} as Env,
      prompt: "A raster product photo",
    })).rejects.toMatchObject({
      name: "AiImageGenerationError",
      message: "Image generation is temporarily unavailable.",
    });
  });

  it("publishes only aspect ratios the configured model can actually accept", async () => {
    const { supportedAiImageAspectRatios } = await import("./image-runtime");
    expect(supportedAiImageAspectRatios(
      "cloudflare",
      "openai/gpt-image-1.5",
    )).toEqual(["auto", "1:1"]);
    expect(supportedAiImageAspectRatios(
      "cloudflare",
      "openai/gpt-image-2",
    )).toEqual(["auto", "1:1", "2:3", "3:2"]);
    expect(supportedAiImageAspectRatios(
      "cloudflare",
      "@cf/black-forest-labs/flux-1-schnell",
    )).toEqual(["auto"]);
  });
});
