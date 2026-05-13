import { OpenAPIHono, z } from "@hono/zod-openapi";
import { generateStructuredPrompt } from "@scalius/core/modules/ai/prompt-helper-v2";
import {
  GENERATION_CONFIG,
  getConfiguredProvider,
  getTimeout,
  getWidgetAiPrompt,
  requireAllowedWidgetAiModel,
  resolveWidgetAiModelCapabilities,
  type WidgetAiProvider,
} from "@scalius/core/modules/ai";
import {
  enforceAiRateLimit,
  getCreateOutputBudget,
  getLanguageModel,
  runtimeSettings,
  streamWidgetContent,
  withDestinationRuntimeContract,
} from "./ai";
import { normalizeWidgetGenerationText } from "./ai-response-validation";
import { normalizeMessages } from "./ai-message-normalization";
import { parseTagBasedResponse } from "@scalius/shared/tag-parser";
import { resolveAiContextBatchDetails } from "./ai-context";
import {
  createWidgetGenerationToolRunner,
  type WidgetGenerationToolEvent,
  type WidgetGenerationToolName,
} from "./widget-generation-tools";

const app = new OpenAPIHono<{ Bindings: Env }>();

const promptTypeSchema = z.enum(["widget", "landing-page", "collection"]);
const providerSchema = z.enum(["openrouter", "openai", "gemini", "cloudflare"]);
const MAX_IMAGE_URL_LENGTH = 4096;

function isAllowedWidgetImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "data:";
  } catch {
    return false;
  }
}

const selectedImageSchema = z
  .object({
    id: z.string().max(200).optional(),
    url: z
      .string()
      .min(1)
      .max(MAX_IMAGE_URL_LENGTH)
      .refine(isAllowedWidgetImageUrl, "Image URLs must use HTTPS or data URLs."),
    filename: z.string().max(500).optional(),
    size: z.number().int().min(0).optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    mimeType: z.string().max(120).optional(),
    alt: z.string().max(500).optional(),
  })
  .passthrough();

const widgetGenerationRunSchema = z.object({
  provider: providerSchema.optional(),
  model: z.string().max(200).optional(),
  promptType: promptTypeSchema.default("widget"),
  operation: z.enum(["create", "improve"]).default("create"),
  userPrompt: z.string().min(1).max(20_000),
  existingHtml: z.string().max(200_000).optional(),
  existingCss: z.string().max(200_000).optional(),
  targetSection: z.number().int().min(0).optional(),
  sections: z
    .array(
      z.object({
        html: z.string().max(100_000),
        css: z.string().max(100_000).optional().default(""),
        description: z.string().max(240).optional(),
      }),
    )
    .max(20)
    .optional(),
  improvementHistory: z
    .array(
      z.object({
        section: z.number().int().min(0).optional(),
        prompt: z.string().max(2_000),
        timestamp: z.number().optional(),
        modelUsed: z.string().max(200).optional(),
      }),
    )
    .max(30)
    .optional(),
  selectedImages: z
    .array(selectedImageSchema)
    .max(GENERATION_CONFIG.context.maxImages)
    .optional(),
  productIds: z.array(z.string().max(200)).max(GENERATION_CONFIG.context.maxProducts).optional(),
  categoryIds: z.array(z.string().max(200)).max(GENERATION_CONFIG.context.maxCategories).optional(),
  collectionIds: z.array(z.string().max(200)).max(GENERATION_CONFIG.context.maxCollections).optional(),
  anchorCollectionIds: z.array(z.string().max(200)).max(GENERATION_CONFIG.context.maxCollections).optional(),
  allCategoriesSelected: z.boolean().optional(),
});

type WidgetGenerationRunEvent =
  | { type: "run.started"; runId: string; operation: "create" | "improve" }
  | WidgetGenerationToolEvent
  | { type: "step.started"; step: WidgetGenerationToolName }
  | { type: "step.completed"; step: WidgetGenerationToolName; elapsedMs: number; metadata?: Record<string, unknown> }
  | { type: "draft.delta"; delta: string }
  | { type: "preview.patch"; html: string; css: string; metadata?: Record<string, unknown> }
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

function isExpectedAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

type WidgetGenerationRunPayload = z.infer<typeof widgetGenerationRunSchema>;

function getImprovementCode(payload: WidgetGenerationRunPayload): { html: string; css: string } {
  if (payload.targetSection !== undefined && payload.sections?.[payload.targetSection]) {
    const section = payload.sections[payload.targetSection]!;
    return { html: section.html, css: section.css || "" };
  }

  return {
    html: payload.existingHtml || "",
    css: payload.existingCss || "",
  };
}

function buildImprovementInstruction(payload: WidgetGenerationRunPayload): string {
  const parts = [payload.userPrompt.trim()];

  if (payload.improvementHistory?.length) {
    parts.push(
      `PREVIOUS IMPROVEMENTS:\n${payload.improvementHistory
        .map(
          (entry, index) =>
            `${index + 1}. ${entry.section !== undefined ? `Section ${entry.section + 1}` : "Whole widget"}: "${entry.prompt}"`,
        )
        .join("\n")}\nBuild on these previous improvements. Do not revert earlier accepted changes.`,
    );
  }

  if (payload.targetSection !== undefined && payload.sections && payload.sections.length > 1) {
    const otherSections = payload.sections
      .map((section, index) => {
        if (index === payload.targetSection) return null;
        return `Section ${index + 1}${section.description ? ` (${section.description})` : ""}:\n<htmljs>\n${section.html}\n</htmljs>\n<css>\n${section.css || "/* No CSS */"}\n</css>`;
      })
      .filter(Boolean);

    if (otherSections.length > 0) {
      parts.push(
        `OTHER SECTIONS CONTEXT:\nYou are improving Section ${payload.targetSection + 1} of ${payload.sections.length}. Keep visual continuity with these sections, but return only the improved target section code.\n\n${otherSections.join("\n\n")}`,
      );
    }
  }

  return parts.join("\n\n");
}

function buildPreviewScaffold(
  promptType: WidgetGenerationRunPayload["promptType"],
  contextData: Awaited<ReturnType<typeof resolveAiContextBatchDetails>>,
): { html: string; css: string } {
  const title =
    promptType === "landing-page"
      ? "Building campaign section"
      : promptType === "collection"
        ? "Building collection section"
        : "Building homepage section";
  const productNames = contextData.products
    .slice(0, 4)
    .map((product) => product.name)
    .filter(Boolean);
  const items = productNames.length > 0 ? productNames : ["Layout", "Products", "Actions"];

  return {
    html: `<section class="sc-widget-draft" aria-label="${escapeHtml(title)}">
  <div class="sc-widget-draft__copy">
    <p class="sc-widget-draft__eyebrow">Scalius AI</p>
    <h2>${escapeHtml(title)}</h2>
    <p>Hydrating store context, shaping the layout, and validating storefront-safe HTML/CSS.</p>
  </div>
  <div class="sc-widget-draft__items">
    ${items.map((item) => `<span>${escapeHtml(item)}</span>`).join("\n    ")}
  </div>
</section>`,
    css: `.sc-widget-draft{margin:0;padding:28px 18px;background:linear-gradient(135deg,#f8fafc,#ffffff 48%,#eef7f1);color:#111827;border-radius:14px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:22px;align-items:center}.sc-widget-draft__eyebrow{margin:0 0 8px;font-size:12px;font-weight:800;text-transform:uppercase;color:#3f6f52}.sc-widget-draft h2{margin:0;font-size:clamp(28px,4vw,44px);line-height:1.02}.sc-widget-draft p{margin:10px 0 0;max-width:58ch;color:#4b5563;font-size:15px;line-height:1.5}.sc-widget-draft__items{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end}.sc-widget-draft__items span{padding:10px 12px;border:1px solid #d7dde4;border-radius:10px;background:#fff;font-weight:700;font-size:13px}@media(max-width:760px){.sc-widget-draft{grid-template-columns:1fr}.sc-widget-draft__items{justify-content:flex-start}}`,
  };
}

function buildPreviewPatchFromRaw(rawText: string, commerceFactsProvided: boolean): { html: string; css: string } | null {
  try {
    const normalized = normalizeWidgetGenerationText(rawText, { commerceFactsProvided });
    const tagResult = parseTagBasedResponse(normalized);
    if (!tagResult.success || !tagResult.data) return null;
    return {
      html: tagResult.data.html,
      css: tagResult.data.css || "",
    };
  } catch {
    return null;
  }
}

app.post("/", async (c) => {
  const payload = widgetGenerationRunSchema.parse(await c.req.json());
  const db = c.get("db");
  const runId = crypto.randomUUID();
  let streamClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: WidgetGenerationRunEvent): void => {
        if (streamClosed) return;
        try {
          controller.enqueue(encodeSse(event));
        } catch {
          streamClosed = true;
        }
      };
      const tools = createWidgetGenerationToolRunner(emit, emit);

      try {
        emit({ type: "run.started", runId, operation: payload.operation });
        await enforceAiRateLimit(c);

        const settings = await tools.run("load_settings", () => runtimeSettings(c));
        const provider = getConfiguredProvider(settings, payload.provider) as WidgetAiProvider;
        const modelId = requireAllowedWidgetAiModel(settings, provider, payload.model);
        const capabilities = resolveWidgetAiModelCapabilities(
          provider,
          modelId,
          settings.providers[provider].capabilities,
        );
        const model = getLanguageModel(provider, modelId, settings, c.env);

        const contextData = await tools.run(
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
        emit({
          type: "preview.patch",
          ...buildPreviewScaffold(payload.promptType, contextData),
          metadata: { stage: "context-loaded", draft: true },
        });

        const promptResult = await tools.run(
          "build_prompt",
          async () => {
            const systemPrompt = await getWidgetAiPrompt(db, payload.promptType);
            const improvementCode = payload.operation === "improve" ? getImprovementCode(payload) : null;
            return generateStructuredPrompt({
              systemPrompt,
              userPrompt: payload.operation === "create" ? payload.userPrompt : undefined,
              improvementPrompt: payload.operation === "improve" ? buildImprovementInstruction(payload) : undefined,
              existingHtml: improvementCode?.html,
              existingCss: improvementCode?.css,
              selectedImages: toPromptImages(payload.selectedImages),
              selectedProducts: contextData.products,
              selectedCategories: contextData.categories,
              selectedCollections: contextData.collections,
              allCategoriesSelected: payload.allCategoriesSelected === true,
              modelId,
              supportsVision: capabilities.supportsVisionInput,
              maxImagesOverride: capabilities.maxImages,
              promptType: payload.promptType,
              sectionIndex: payload.targetSection,
              totalSections: payload.sections?.length,
            });
          },
          (value) => ({
            messages: value.messages.length,
            estimatedTokens: value.metadata.estimatedTokens,
          }),
        );

        const result = await tools.run("generate", async () => {
          const messages = withDestinationRuntimeContract(
            normalizeMessages(promptResult.messages),
            payload.promptType,
            { compositionMode: true },
          );
          const generation = streamWidgetContent(
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
          let rawText = "";
          let lastPreviewPatchLength = 0;
          const commerceFactsProvided = Boolean(
            contextData.products.length ||
              contextData.categories.length ||
              contextData.collections.length ||
              payload.selectedImages?.length,
          );
          for await (const delta of generation.textStream) {
            if (!delta) continue;
            rawText += delta;
            emit({ type: "draft.delta", delta });
            if (rawText.length - lastPreviewPatchLength >= 800) {
              const patch = buildPreviewPatchFromRaw(rawText, commerceFactsProvided);
              if (patch) {
                lastPreviewPatchLength = rawText.length;
                emit({
                  type: "preview.patch",
                  ...patch,
                  metadata: { stage: "streaming", draft: true },
                });
              }
            }
          }
          return generation.finalize(rawText);
        });
        tools.artifactValidated({
          provider,
          model: modelId,
          format: "tagged-html-css",
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
        if (!isExpectedAbort(error, c.req.raw.signal)) {
          emit({ type: "run.failed", runId, error: { message: messageFromError(error) } });
        }
      } finally {
        if (!streamClosed) {
          streamClosed = true;
          try {
            controller.close();
          } catch {
            // The browser may have already closed the SSE connection.
          }
        }
      }
    },
    cancel() {
      streamClosed = true;
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
