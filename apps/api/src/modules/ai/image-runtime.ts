import type { ImageModel } from "ai";
import {
  ERROR_MESSAGES,
  getCloudflareImageModelCapability,
  isImageGenerationModel,
  isImageGenerationProvider,
  normalizeCloudflareAiModelId,
  providerHasCredentials,
  type CloudflareImageModelCapability,
  type WidgetAiProvider,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import { inspectGeneratedRaster } from "@scalius/core/modules/media";
import {
  ServiceUnavailableError,
  ValidationError,
} from "../../utils/api-error";

const IMAGE_GENERATION_TIMEOUT_MS = 30_000;
const IMAGE_GENERATION_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_PROMPT_MAX_CHARS = 4_000;
const IMAGE_GENERATION_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CLOUDFLARE_NATIVE_SIZES: Record<string, `${number}x${number}`> = {
  "1:1": "1024x1024",
  "2:3": "768x1152",
  "4:5": "768x960",
  "3:2": "1152x768",
  "16:9": "1024x576",
};
const CLOUDFLARE_OPENAI_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "2:3": "1024x1536",
  "3:2": "1536x1024",
};
const GOOGLE_NANO_BANANA_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);
const GOOGLE_IMAGEN_4_ASPECT_RATIOS = new Set([
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
]);
const OPENAI_GPT_IMAGE_MODELS = new Set([
  "gpt-image-1",
  "gpt-image-1.5",
  "gpt-image-2",
]);

export const AI_IMAGE_ASPECT_RATIOS = [
  "auto", "1:1", "2:3", "4:5", "3:2", "16:9",
] as const;
export type AiImageAspectRatio = (typeof AI_IMAGE_ASPECT_RATIOS)[number];

export function supportedAiImageAspectRatios(
  provider: WidgetAiProvider,
  rawModelId: string,
): readonly AiImageAspectRatio[] {
  const modelId = provider === "cloudflare"
    ? normalizeCloudflareAiModelId(rawModelId)
    : rawModelId.trim();
  if (provider === "cloudflare") {
    const input = getCloudflareImageModelCapability(modelId)?.input;
    if (
      input === "native-json-pixels" ||
      input === "native-multipart-pixels" ||
      input === "unified-google-nano-banana"
    ) {
      return AI_IMAGE_ASPECT_RATIOS;
    }
    if (input === "unified-google-imagen-4") return ["auto", "1:1", "16:9"];
    if (input === "unified-openai-gpt-image-1.5") return ["auto", "1:1"];
    if (input === "unified-openai-gpt-image-2") return ["auto", "1:1", "2:3", "3:2"];
    return ["auto"];
  }
  if (provider === "openai") {
    return OPENAI_GPT_IMAGE_MODELS.has(modelId)
      ? ["auto", "1:1", "2:3", "3:2"]
      : ["auto", "1:1"];
  }
  if (provider === "gemini") {
    return modelId.startsWith("imagen-")
      ? ["auto", "1:1", "16:9"]
      : ["auto", "1:1", "2:3", "4:5", "3:2", "16:9"];
  }
  return ["auto"];
}

export type GeneratedAiImage = {
  bytes: Uint8Array;
  mediaType: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

/** Deliberately contains no provider payload, prompt, credential, or cause. */
export class AiImageGenerationError extends ServiceUnavailableError {
  constructor() {
    super("Image generation is temporarily unavailable.");
    this.name = "AiImageGenerationError";
  }
}

export async function createAiImageModel(
  provider: WidgetAiProvider,
  modelId: string,
  settings: WidgetAiRuntimeSettings,
  env: Env,
): Promise<ImageModel> {
  const requestedModel =
    provider === "cloudflare"
      ? normalizeCloudflareAiModelId(modelId)
      : modelId.trim();
  if (!requestedModel) {
    throw new ValidationError("An image-generation model is required.");
  }
  if (!settings.providers[provider]?.enabled) {
    throw new ValidationError("The selected image-generation provider is disabled.");
  }
  if (
    !isImageGenerationProvider(provider) ||
    !isImageGenerationModel(provider, requestedModel)
  ) {
    throw new ValidationError(
      "The selected provider or model does not support image generation.",
    );
  }
  if (
    provider === "cloudflare"
      ? !env.AI
      : !providerHasCredentials(settings, provider)
  ) {
    throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
  }
  if (provider === "cloudflare" && !requestedModel.startsWith("@cf/")) {
    throw new ValidationError(
      "Cloudflare catalog image models require the unified binding runtime.",
    );
  }
  if (provider === "cloudflare") {
    throw new ValidationError(
      "Cloudflare image models use the direct Workers AI binding runtime.",
    );
  }
  try {
    if (provider === "openai") {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({
        apiKey: settings.apiKeys.openai,
        baseURL: settings.providers.openai.baseUrl,
      }).imageModel(requestedModel as never);
    }

    if (provider === "gemini") {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({
        apiKey: settings.apiKeys.gemini,
        baseURL: settings.providers.gemini.baseUrl,
      }).imageModel(requestedModel as never);
    }
    throw new ValidationError(
      "The selected provider does not support image generation.",
    );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new AiImageGenerationError();
  }
}

export async function generateAiImage(options: {
  provider: WidgetAiProvider;
  modelId: string;
  settings: WidgetAiRuntimeSettings;
  env: Env;
  prompt: string;
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  seed?: number;
  abortSignal?: AbortSignal;
}): Promise<GeneratedAiImage> {
  const prompt = options.prompt.trim();
  if (!prompt || prompt.length > IMAGE_PROMPT_MAX_CHARS) {
    throw new ValidationError(
      `Image prompt must contain 1-${IMAGE_PROMPT_MAX_CHARS} characters.`,
    );
  }

  const deadline = AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS);
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, deadline])
    : deadline;

  try {
    const normalizedModel =
      options.provider === "cloudflare"
        ? normalizeCloudflareAiModelId(options.modelId)
        : options.modelId.trim();
    if (options.provider === "cloudflare") {
      if (normalizedModel.startsWith("@cf/")) {
        return await generateCloudflareNativeImage({
          ...options,
          modelId: normalizedModel,
          prompt,
          signal,
        });
      }
      return await generateCloudflareUnifiedImage({
        ...options,
        modelId: normalizedModel,
        prompt,
        signal,
      });
    }
    const model = await createAiImageModel(
      options.provider,
      options.modelId,
      options.settings,
      options.env,
    );
    const sizing = resolveSdkImageSizing(
      options.provider,
      options.modelId.trim(),
      options.size,
      options.aspectRatio,
      options.seed,
    );
    const { generateImage } = await import("ai");
    const result = await generateImage({
      model,
      prompt,
      n: 1,
      ...sizing,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      maxRetries: 0,
      abortSignal: signal,
    });
    const image = result.image;
    const bytes = image.uint8Array;
    if (
      !IMAGE_GENERATION_MEDIA_TYPES.has(image.mediaType) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > IMAGE_GENERATION_MAX_BYTES ||
      !inspectGeneratedRaster(bytes, image.mediaType)
    ) {
      throw new AiImageGenerationError();
    }
    return {
      bytes,
      mediaType: image.mediaType,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      },
    };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    if (error instanceof AiImageGenerationError) throw error;
    throw new AiImageGenerationError();
  }
}

function resolveSdkImageSizing(
  provider: WidgetAiProvider,
  modelId: string,
  size: `${number}x${number}` | undefined,
  aspectRatio: `${number}:${number}` | undefined,
  seed: number | undefined,
): {
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
} {
  if (size && aspectRatio) {
    throw new ValidationError(
      "Choose either an explicit image size or an aspect ratio, not both.",
    );
  }
  if (provider === "gemini") {
    if (size) {
      throw new ValidationError(
        "Explicit pixel size is not supported by this Google image runtime; choose a verified aspect ratio.",
      );
    }
    if (modelId.startsWith("imagen-")) {
      if (seed !== undefined) {
        throw new ValidationError(
          "Seed is not supported by the selected Google Imagen model.",
        );
      }
      if (aspectRatio && !GOOGLE_IMAGEN_4_ASPECT_RATIOS.has(aspectRatio)) {
        throw new ValidationError(
          "That aspect ratio is not supported by the selected Google Imagen model.",
        );
      }
    }
    return {
      ...(aspectRatio ? { aspectRatio } : {}),
    };
  }
  if (provider !== "openai") return {};
  if (seed !== undefined) {
    throw new ValidationError(
      "Seed is not supported by the selected OpenAI image model.",
    );
  }

  const gptImage = OPENAI_GPT_IMAGE_MODELS.has(modelId);
  const dalle2 = modelId === "dall-e-2";
  const dalle3 = modelId === "dall-e-3";
  if (aspectRatio) {
    const resolved = gptImage
      ? CLOUDFLARE_OPENAI_SIZES[aspectRatio]
      : (dalle2 || dalle3) && aspectRatio === "1:1"
        ? "1024x1024"
        : undefined;
    if (!resolved) {
      throw new ValidationError(
        "That aspect ratio does not have an exact size for the selected OpenAI image model.",
      );
    }
    return { size: resolved as `${number}x${number}` };
  }
  if (!size) return {};

  const supported = gptImage
    ? new Set(["1024x1024", "1024x1536", "1536x1024"])
    : dalle2
      ? new Set(["256x256", "512x512", "1024x1024"])
      : dalle3
        ? new Set(["1024x1024", "1024x1792", "1792x1024"])
        : undefined;
  if (!supported?.has(size)) {
    throw new ValidationError(
      "That pixel size is not supported by the selected OpenAI image model.",
    );
  }
  return { size };
}

async function generateCloudflareNativeImage(options: {
  provider: WidgetAiProvider;
  modelId: string;
  settings: WidgetAiRuntimeSettings;
  env: Env;
  prompt: string;
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  seed?: number;
  signal: AbortSignal;
}): Promise<GeneratedAiImage> {
  const { ai, capability } = requireCloudflareImageBinding(options);
  if (
    capability.input === "native-json-default-size" &&
    options.prompt.length > 2_048
  ) {
    throw new ValidationError(
      "This native Workers AI image model accepts prompts up to 2,048 characters.",
    );
  }
  if (
    capability.input === "native-json-default-size" &&
    options.seed !== undefined
  ) {
    throw new ValidationError(
      "Seed is not supported by this native Workers AI image model.",
    );
  }
  const dimensions = resolveCloudflareNativeDimensions(
    capability,
    options.size,
    options.aspectRatio,
  );
  let response: unknown;

  if (capability.input === "native-multipart-pixels") {
    const form = new FormData();
    form.append("prompt", options.prompt);
    if (dimensions) {
      form.append("width", String(dimensions.width));
      form.append("height", String(dimensions.height));
    }
    if (options.seed !== undefined) form.append("seed", String(options.seed));
    const encoded = new Response(form);
    const body = encoded.body;
    const contentType = encoded.headers.get("content-type");
    if (!body || !contentType) throw new AiImageGenerationError();
    response = await ai.run(
      options.modelId,
      { multipart: { body, contentType } },
      { signal: options.signal },
    );
  } else if (
    capability.input === "native-json-pixels" ||
    capability.input === "native-json-default-size"
  ) {
    response = await ai.run(
      options.modelId,
      {
        prompt: options.prompt,
        ...(dimensions ?? {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
      },
      { signal: options.signal },
    );
  } else {
    throw new ValidationError(
      "The selected Cloudflare model is not a native Workers AI image model.",
    );
  }

  const raster = await extractCloudflareNativeRaster(
    response,
    capability.output,
  );
  return { ...raster, usage: {} };
}

async function generateCloudflareUnifiedImage(options: {
  provider: WidgetAiProvider;
  modelId: string;
  settings: WidgetAiRuntimeSettings;
  env: Env;
  prompt: string;
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  seed?: number;
  signal: AbortSignal;
}): Promise<GeneratedAiImage> {
  const { ai, capability } = requireCloudflareImageBinding(options);
  if (options.seed !== undefined || options.size !== undefined) {
    throw new ValidationError(
      "Seed and explicit pixel size are not supported by Cloudflare catalog image models.",
    );
  }

  const input = cloudflareUnifiedImageInput(
    capability,
    options.prompt,
    options.aspectRatio,
  );
  const response = await ai.run(
    options.modelId,
    input,
    {
      gateway: { id: "default" },
      signal: options.signal,
    },
  );
  const imageUrl = parseCloudflareUnifiedImageUrl(response);
  if (!imageUrl) throw new AiImageGenerationError();

  const imageResponse = await fetch(imageUrl, {
    method: "GET",
    redirect: "error",
    headers: { Accept: "image/png,image/jpeg,image/webp" },
    signal: options.signal,
  });
  if (!imageResponse.ok) throw new AiImageGenerationError();
  const mediaType = normalizedImageMediaType(
    imageResponse.headers.get("content-type"),
  );
  if (!mediaType) {
    await imageResponse.body?.cancel();
    throw new AiImageGenerationError();
  }
  await rejectOversizedContentLength(
    imageResponse.headers.get("content-length"),
    imageResponse,
  );
  const bytes = await readBoundedStream(
    imageResponse.body,
    IMAGE_GENERATION_MAX_BYTES,
  );
  if (!inspectGeneratedRaster(bytes, mediaType)) {
    throw new AiImageGenerationError();
  }
  return { bytes, mediaType, usage: {} };
}

function cloudflareUnifiedImageInput(
  capability: CloudflareImageModelCapability,
  prompt: string,
  aspectRatio: `${number}:${number}` | undefined,
): Record<string, unknown> {
  if (capability.input === "unified-google-nano-banana") {
    if (
      aspectRatio &&
      !GOOGLE_NANO_BANANA_ASPECT_RATIOS.has(aspectRatio)
    ) {
      throw new ValidationError(
        "That aspect ratio is not supported by this Cloudflare Google image model.",
      );
    }
    return {
      prompt,
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      output_format: "png",
    };
  }
  if (capability.input === "unified-google-imagen-4") {
    if (aspectRatio && !GOOGLE_IMAGEN_4_ASPECT_RATIOS.has(aspectRatio)) {
      throw new ValidationError(
        "That aspect ratio is not supported by Cloudflare Imagen 4. Use provider default, 1:1, 3:4, 4:3, 9:16, or 16:9.",
      );
    }
    return {
      prompt,
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    };
  }
  if (capability.input === "unified-openai-gpt-image-1.5") {
    if (aspectRatio && aspectRatio !== "1:1") {
      throw new ValidationError(
        "That aspect ratio is not supported by Cloudflare GPT Image 1.5. Use provider default or 1:1.",
      );
    }
    return {
      prompt,
      ...(aspectRatio ? { size: "1024x1024" } : {}),
    };
  }
  if (capability.input === "unified-openai-gpt-image-2") {
    const size = aspectRatio
      ? CLOUDFLARE_OPENAI_SIZES[aspectRatio]
      : undefined;
    if (aspectRatio && !size) {
      throw new ValidationError(
        "That aspect ratio is not supported by this Cloudflare OpenAI image model. Use provider default, 1:1, 2:3, or 3:2.",
      );
    }
    return {
      prompt,
      ...(size ? { size } : {}),
      output_format: "png",
    };
  }
  throw new ValidationError(
    "The selected Cloudflare catalog image model is not supported.",
  );
}

function requireCloudflareImageBinding(options: {
  provider: WidgetAiProvider;
  modelId: string;
  settings: WidgetAiRuntimeSettings;
  env: Env;
}): { ai: Ai; capability: CloudflareImageModelCapability } {
  const capability = getCloudflareImageModelCapability(options.modelId);
  if (
    options.provider !== "cloudflare" ||
    !options.settings.providers.cloudflare.enabled ||
    !capability
  ) {
    throw new ValidationError(
      "The selected provider or model does not support image generation.",
    );
  }
  if (!options.env.AI) {
    throw new ValidationError(
      "Cloudflare image generation requires the Workers AI binding.",
    );
  }
  return { ai: options.env.AI, capability };
}

function resolveCloudflareNativeDimensions(
  capability: CloudflareImageModelCapability,
  size: `${number}x${number}` | undefined,
  aspectRatio: `${number}:${number}` | undefined,
): { width: number; height: number } | undefined {
  if (size && aspectRatio) {
    throw new ValidationError(
      "Choose either an explicit image size or an aspect ratio, not both.",
    );
  }
  if (
    capability.input === "native-json-default-size" &&
    (size || aspectRatio)
  ) {
    throw new ValidationError(
      "This native Workers AI image model supports only its provider-default aspect ratio.",
    );
  }
  const resolvedSize = size ?? (
    aspectRatio ? CLOUDFLARE_NATIVE_SIZES[aspectRatio] : undefined
  );
  if (aspectRatio && !resolvedSize) {
    throw new ValidationError(
      "The selected aspect ratio is not supported by this native Workers AI image model.",
    );
  }
  if (!resolvedSize) return undefined;
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(resolvedSize);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 4_096 ||
    height > 4_096 ||
    width * height > 16_777_216
  ) {
    throw new ValidationError("The requested image size is not supported.");
  }
  return { width, height };
}

async function extractCloudflareNativeRaster(
  value: unknown,
  output: CloudflareImageModelCapability["output"],
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  if (output === "native-base64") {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["image"]) ||
      typeof value.image !== "string"
    ) {
      throw new AiImageGenerationError();
    }
    return identifyGeneratedRaster(decodeBoundedBase64Image(value.image));
  }
  if (output !== "native-raster") throw new AiImageGenerationError();
  if (value instanceof Response) {
    const mediaType = normalizedImageMediaType(
      value.headers.get("content-type"),
    );
    if (!mediaType) {
      await value.body?.cancel();
      throw new AiImageGenerationError();
    }
    await rejectOversizedContentLength(
      value.headers.get("content-length"),
      value,
    );
    const bytes = await readBoundedStream(
      value.body,
      IMAGE_GENERATION_MAX_BYTES,
    );
    if (!inspectGeneratedRaster(bytes, mediaType)) {
      throw new AiImageGenerationError();
    }
    return { bytes, mediaType };
  }

  if (value instanceof ReadableStream) {
    const bytes = await readBoundedStream(value, IMAGE_GENERATION_MAX_BYTES);
    return identifyGeneratedRaster(bytes);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_GENERATION_MAX_BYTES) {
      throw new AiImageGenerationError();
    }
    return identifyGeneratedRaster(bytes);
  }
  throw new AiImageGenerationError();
}

function decodeBoundedBase64Image(value: string): Uint8Array {
  const maxEncodedLength = Math.ceil(IMAGE_GENERATION_MAX_BYTES / 3) * 4;
  if (
    value.length === 0 ||
    value.length > maxEncodedLength ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
  ) {
    throw new AiImageGenerationError();
  }
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0)
    );
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_GENERATION_MAX_BYTES) {
      throw new AiImageGenerationError();
    }
    return bytes;
  } catch (error) {
    if (error instanceof AiImageGenerationError) throw error;
    throw new AiImageGenerationError();
  }
}

function identifyGeneratedRaster(
  bytes: Uint8Array,
): { bytes: Uint8Array; mediaType: string } {
  for (const mediaType of IMAGE_GENERATION_MEDIA_TYPES) {
    if (inspectGeneratedRaster(bytes, mediaType)) return { bytes, mediaType };
  }
  throw new AiImageGenerationError();
}

function parseCloudflareUnifiedImageUrl(value: unknown): string | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "gatewayMetadata",
    "result",
    "state",
  ])) return null;
  if (
    value.state !== "Completed" ||
    !isRecord(value.gatewayMetadata) ||
    !isRecord(value.result)
  ) return null;
  if (!hasOnlyKeys(value.result, ["image"]) ||
      typeof value.result.image !== "string" ||
      value.result.image.length > 2_048) return null;
  try {
    const url = new URL(value.result.image);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedImageMediaType(value: string | null): string | null {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return IMAGE_GENERATION_MEDIA_TYPES.has(mediaType) ? mediaType : null;
}

async function rejectOversizedContentLength(
  value: string | null,
  response: Response,
): Promise<void> {
  if (
    value &&
    /^\d+$/u.test(value) &&
    Number(value) > IMAGE_GENERATION_MAX_BYTES
  ) {
    await response.body?.cancel();
    throw new AiImageGenerationError();
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) throw new AiImageGenerationError();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AiImageGenerationError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new AiImageGenerationError();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).length === allowed.length &&
    Object.keys(value).every((key) => allowed.includes(key));
}
