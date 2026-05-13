import { OpenAPIHono, z } from "@hono/zod-openapi";
import { generateStructuredPrompt } from "@scalius/core/modules/ai/prompt-helper-v2";
import {
  getConfiguredProvider,
  getTimeout,
  getWidgetAiPrompt,
  requireAllowedWidgetAiModel,
  resolveWidgetAiModelCapabilities,
  type WidgetAiProvider,
} from "@scalius/core/modules/ai";
import {
  enforceAiRateLimit,
  generateWidgetContent,
  getCreateOutputBudget,
  getLanguageModel,
  runtimeSettings,
  withDestinationRuntimeContract,
} from "./ai";
import { normalizeMessages } from "./ai-message-normalization";
import { resolveAiContextBatchDetails } from "./ai-context";

const app = new OpenAPIHono<{ Bindings: Env }>();

const promptTypeSchema = z.enum(["widget", "landing-page", "collection"]);
const providerSchema = z.enum(["openrouter", "openai", "gemini", "cloudflare"]);

const widgetGenerationRunSchema = z.object({
  provider: providerSchema.optional(),
  model: z.string().max(200).optional(),
  promptType: promptTypeSchema.default("widget"),
  operation: z.enum(["create", "improve"]).default("create"),
  userPrompt: z.string().min(1).max(20_000),
  selectedImages: z
    .array(
      z
        .object({
          url: z.string(),
          mimeType: z.string().optional(),
          alt: z.string().optional(),
        })
        .passthrough(),
    )
    .optional(),
  productIds: z.array(z.string()).optional(),
  categoryIds: z.array(z.string()).optional(),
  collectionIds: z.array(z.string()).optional(),
  anchorCollectionIds: z.array(z.string()).optional(),
  allCategoriesSelected: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  maxImages: z.number().int().positive().optional(),
});

type WidgetGenerationRunEvent =
  | { type: "run.started"; runId: string; operation: "create" | "improve" }
  | { type: "step.started"; step: string }
  | { type: "step.completed"; step: string; elapsedMs: number; metadata?: Record<string, unknown> }
  | { type: "warning"; warnings: unknown }
  | { type: "artifact"; raw: string; metadata?: Record<string, unknown> }
  | { type: "run.completed"; runId: string; usage?: unknown }
  | { type: "run.failed"; runId: string; error: { message: string } };

function eventName(type: WidgetGenerationRunEvent["type"]): string {
  return type;
}

function encodeSse(event: WidgetGenerationRunEvent): Uint8Array {
  return new TextEncoder().encode(
    `event: ${eventName(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Widget generation failed");
}

function toPromptImages(images: z.infer<typeof widgetGenerationRunSchema>["selectedImages"]) {
  return (images ?? []).map((image, index) => ({
    id: typeof image.id === "string" ? image.id : `selected-image-${index + 1}`,
    url: image.url,
    filename:
      typeof image.filename === "string"
        ? image.filename
        : image.url.split("/").pop()?.split("?")[0] || `selected-image-${index + 1}`,
    size: typeof image.size === "number" ? image.size : 0,
    createdAt: image.createdAt instanceof Date ? image.createdAt : new Date(0),
  }));
}

app.post("/", async (c) => {
  const payload = widgetGenerationRunSchema.parse(await c.req.json());
  const db = c.get("db");
  const runId = crypto.randomUUID();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: WidgetGenerationRunEvent) => controller.enqueue(encodeSse(event));
      const timedStep = async <T>(
        step: string,
        action: () => Promise<T>,
        metadata?: (value: T) => Record<string, unknown>,
      ): Promise<T> => {
        const startedAt = Date.now();
        emit({ type: "step.started", step });
        const value = await action();
        emit({
          type: "step.completed",
          step,
          elapsedMs: Date.now() - startedAt,
          metadata: metadata?.(value),
        });
        return value;
      };

      try {
        emit({ type: "run.started", runId, operation: payload.operation });
        await enforceAiRateLimit(c);

        const settings = await timedStep("load_settings", () => runtimeSettings(c));
        const provider = getConfiguredProvider(settings, payload.provider) as WidgetAiProvider;
        const modelId = requireAllowedWidgetAiModel(settings, provider, payload.model);
        const capabilities = resolveWidgetAiModelCapabilities(
          provider,
          modelId,
          settings.providers[provider].capabilities,
        );
        const model = getLanguageModel(provider, modelId, settings, c.env);

        const contextData = await timedStep(
          "hydrate_context",
          () =>
            resolveAiContextBatchDetails({
              db,
              env: c.env,
              payload: {
                productIds: payload.productIds,
                categoryIds: payload.allCategoriesSelected ? undefined : payload.categoryIds,
                collectionIds: payload.collectionIds,
                anchorCollectionIds: payload.anchorCollectionIds,
                allCategories: payload.allCategoriesSelected,
              },
            }),
          (value) => ({
            products: value.products.length,
            categories: value.categories.length,
            collections: value.collections.length,
          }),
        );
        emit({ type: "warning", warnings: contextData.warnings });

        const promptResult = await timedStep(
          "build_prompt",
          async () => {
            const systemPrompt = await getWidgetAiPrompt(db, payload.promptType);
            return generateStructuredPrompt({
              systemPrompt,
              userPrompt: payload.userPrompt,
              selectedImages: toPromptImages(payload.selectedImages),
              selectedProducts: contextData.products,
              selectedCategories: contextData.categories,
              selectedCollections: contextData.collections,
              allCategoriesSelected: payload.allCategoriesSelected === true,
              modelId,
              supportsVision: payload.supportsVision === true,
              maxImagesOverride: payload.maxImages,
              promptType: payload.promptType,
            });
          },
          (value) => ({
            messages: value.messages.length,
            estimatedTokens: value.metadata.estimatedTokens,
          }),
        );

        const result = await timedStep("generate", async () => {
          const messages = withDestinationRuntimeContract(
            normalizeMessages(promptResult.messages),
            payload.promptType,
            { compositionMode: true },
          );
          return generateWidgetContent(
            {
              model,
              messages,
              allowSystemInMessages: true,
              temperature:
                payload.operation === "improve"
                  ? settings.generation.improvementTemperature
                  : settings.generation.generationTemperature,
              maxOutputTokens: getCreateOutputBudget(settings, payload.promptType, payload.operation),
              timeout: {
                totalMs: getTimeout(payload.operation === "improve" ? "improvement" : "generation"),
              },
              maxRetries: 2,
              abortSignal: c.req.raw.signal,
            },
            capabilities,
            payload.promptType,
          );
        });

        emit({
          type: "artifact",
          raw: result.text,
          metadata: {
            provider,
            model: modelId,
          },
        });
        emit({ type: "run.completed", runId, usage: result.usage });
      } catch (error) {
        emit({ type: "run.failed", runId, error: { message: messageFromError(error) } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

export { app as adminWidgetGenerationRunRoutes };
