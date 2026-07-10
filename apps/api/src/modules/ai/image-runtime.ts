import type { ImageModel } from "ai";
import {
  ERROR_MESSAGES,
  providerHasCredentials,
  type WidgetAiProvider,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
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
  const requestedModel = modelId.trim();
  if (!requestedModel) {
    throw new ValidationError("An image-generation model is required.");
  }
  if (!settings.providers[provider]?.enabled) {
    throw new ValidationError("The selected image-generation provider is disabled.");
  }
  if (!providerHasCredentials(settings, provider)) {
    throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
  }
  if (provider === "openrouter") {
    throw new ValidationError(
      "The selected provider does not expose a supported image-generation adapter.",
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

    const { createWorkersAI } = await import("workers-ai-provider");
    if (env.AI) {
      return createWorkersAI({ binding: env.AI as Ai }).imageModel(
        requestedModel,
      );
    }
    const accountId = settings.providers.cloudflare.accountId;
    const apiKey = settings.apiKeys.cloudflare;
    if (!accountId || !apiKey) {
      throw new ValidationError(ERROR_MESSAGES.apiKeyMissing);
    }
    return createWorkersAI({ accountId, apiKey }).imageModel(requestedModel);
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
    const model = await createAiImageModel(
      options.provider,
      options.modelId,
      options.settings,
      options.env,
    );
    const { generateImage } = await import("ai");
    const result = await generateImage({
      model,
      prompt,
      n: 1,
      ...(options.size ? { size: options.size } : {}),
      ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      maxRetries: 0,
      abortSignal: signal,
    });
    const image = result.image;
    const bytes = image.uint8Array;
    if (
      !IMAGE_GENERATION_MEDIA_TYPES.has(image.mediaType) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > IMAGE_GENERATION_MAX_BYTES
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
