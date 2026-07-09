import { z } from "@hono/zod-openapi";
import type { ModelMessage } from "ai";
import {
  GENERATION_CONFIG,
  WIDGET_DESTINATION_RUNTIME_CONTRACTS,
  createWidgetCompositionContract,
  type WidgetAiRuntimeSettings,
} from "@scalius/core/modules/ai";
import { ValidationError } from "../../utils/api-error";
import type { WidgetPromptType } from "./ai-response-validation";

const MAX_MESSAGES = 32;
const MAX_TEXT_CHARS = GENERATION_CONFIG.context.maxPromptChars;
const MAX_IMAGES = GENERATION_CONFIG.context.maxImages;

export const messagePartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    image_url: z.object({ url: z.string() }).optional(),
    image: z.string().optional(),
    mediaType: z.string().optional(),
    cache_control: z.unknown().optional(),
  })
  .passthrough();

export const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(messagePartSchema)]),
});

export type GenerateTextOptions = Parameters<
  (typeof import("ai"))["generateText"]
>[0];
export type GenerateTextResult = Awaited<
  ReturnType<(typeof import("ai"))["generateText"]>
>;
export type GenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export interface WidgetGenerationResult {
  text: string;
  usage: GenerationUsage;
}

export function modelMessageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function inferPromptTypeFromMessages(
  messages: ModelMessage[],
): WidgetPromptType {
  const text = messages
    .map((message) => modelMessageContentText(message.content))
    .join("\n")
    .toLowerCase();
  if (text.includes("homepage widget contract:")) return "widget";
  if (text.includes("collection section contract:")) return "collection";
  if (text.includes("landing section contract:")) return "landing-page";
  return "widget";
}

export function withDestinationRuntimeContract(
  messages: ModelMessage[],
  promptType: WidgetPromptType,
  options: { compositionMode?: boolean } = {},
): ModelMessage[] {
  const compositionContract = options.compositionMode
    ? `\n\n${createWidgetCompositionContract(promptType)}`
    : "";

  return [
    ...messages,
    {
      role: "system",
      content: `${WIDGET_DESTINATION_RUNTIME_CONTRACTS[promptType]}

SERVER PERFORMANCE CONTRACT:
- Produce one complete artifact in this call. Do not wait for a later stage to make it coherent.
- Keep the artifact compact: one root section, concise HTML, and CSS that can finish comfortably inside the output budget. Emit <css> before <htmljs>.
- Homepage and collection widgets should usually be one connected commerce section with 2-4 product cards, not a mini-page.
- Finish the core CSS before optional hover states, decorative effects, or extra responsive refinements. Never leave a CSS rule or property unfinished.
- Do not emit inline SVG icons, icon sprites, long comments, duplicate selectors, or decorative code that does not materially improve the merchant-facing section.
- Put optional JavaScript in <js> only when it improves local widget interaction. JS must use widget.root, widget.query(), or widget.queryAll() and must not touch global storefront state.
- Use no markdown.
- The platform owns runtime wrappers. Do not emit widget-container, cms-widget-frame, widget-placement-zone, data-scalius-widget-root, or data-widget-id in generated HTML.
- Use one content wrapper or section with destination-specific classes and margin: 0. Avoid min-height: 100vh, fixed viewport heights, large spacer elements, or disconnected full-page bands.
- Bound every product image in a stable card/media container with aspect-ratio, max-height, and object-fit. Do not generate blank white media panels, off-canvas crops, absolutely positioned product cutouts, or oversized empty columns.
- The rendered first viewport must look intentionally filled on desktop and mobile: no dead rows, no decorative whitespace blocks, and no product image region larger than its useful content.${compositionContract}`,
    } as ModelMessage,
  ];
}

export function getCreateOutputBudget(
  settings: WidgetAiRuntimeSettings,
  promptType: WidgetPromptType,
  operation?: "create" | "improve",
): number {
  if (operation === "improve") return settings.generation.maxOutputTokens;

  const fastBudget = settings.generation.fastGenerationMaxOutputTokens;
  const maxBudget = settings.generation.maxOutputTokens;
  const targetBudget =
    promptType === "landing-page"
      ? Math.max(fastBudget, 4400)
      : promptType === "collection"
        ? Math.max(fastBudget, 3600)
        : Math.max(fastBudget, 3200);

  return Math.min(maxBudget, targetBudget);
}

export function getStagedOutputBudget(
  settings: WidgetAiRuntimeSettings,
  stage: "plan" | "generate" | "finalize" | undefined,
  promptType: WidgetPromptType,
): number {
  if (stage === "plan")
    return Math.min(settings.generation.maxOutputTokens, 1200);
  if (stage === "finalize")
    return Math.min(
      settings.generation.maxOutputTokens,
      promptType === "landing-page" ? 3600 : 2800,
    );
  if (promptType === "landing-page")
    return Math.min(settings.generation.maxOutputTokens, 3200);
  if (promptType === "collection")
    return Math.min(settings.generation.maxOutputTokens, 2800);
  return Math.min(settings.generation.maxOutputTokens, 2400);
}

export function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "data:";
  } catch {
    return false;
  }
}

export function countMessageText(
  content: z.infer<typeof messageSchema>["content"],
): number {
  if (typeof content === "string") return content.length;
  return content.reduce((total, part) => {
    if (typeof part.text === "string") return total + part.text.length;
    const imageUrl = part.image_url?.url ?? part.image;
    return total + (imageUrl ? String(imageUrl).length : 0);
  }, 0);
}

export function countMessageImages(
  content: z.infer<typeof messageSchema>["content"],
): number {
  if (typeof content === "string") return 0;
  return content.reduce((total, part) => {
    return total + (part.image_url?.url || part.image ? 1 : 0);
  }, 0);
}

export function validateMessagePayload(
  messages: Array<z.infer<typeof messageSchema>>,
): void {
  if (messages.length > MAX_MESSAGES) {
    throw new ValidationError(
      `Too many AI messages. Maximum is ${MAX_MESSAGES}.`,
    );
  }

  const textChars = messages.reduce(
    (total, message) => total + countMessageText(message.content),
    0,
  );
  if (textChars > MAX_TEXT_CHARS) {
    throw new ValidationError(
      `AI prompt is too large. Maximum is ${MAX_TEXT_CHARS} characters.`,
    );
  }

  const imageCount = messages.reduce(
    (total, message) => total + countMessageImages(message.content),
    0,
  );
  if (imageCount > MAX_IMAGES) {
    throw new ValidationError(
      `Too many image inputs. Maximum is ${MAX_IMAGES}.`,
    );
  }

  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      const imageUrl = part.image_url?.url ?? part.image;
      if (imageUrl && !isAllowedImageUrl(String(imageUrl))) {
        throw new ValidationError("AI image URLs must use HTTPS or data URLs.");
      }
    }
  }
}

export function validatePromptPayload(
  prompt: string,
  images: Array<{ url: string; mimeType?: string }> | undefined,
): void {
  if (prompt.length > MAX_TEXT_CHARS) {
    throw new ValidationError(
      `AI prompt is too large. Maximum is ${MAX_TEXT_CHARS} characters.`,
    );
  }
  if ((images?.length ?? 0) > MAX_IMAGES) {
    throw new ValidationError(
      `Too many image inputs. Maximum is ${MAX_IMAGES}.`,
    );
  }
  for (const image of images ?? []) {
    if (!isAllowedImageUrl(image.url)) {
      throw new ValidationError("AI image URLs must use HTTPS or data URLs.");
    }
  }
}

export function promptToMessages(
  prompt: string,
  images: Array<{ url: string; mimeType?: string }> | undefined,
): ModelMessage[] {
  if (!images?.length) return [{ role: "user", content: prompt }];
  return [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.map((image) => {
          try {
            return {
              type: "image" as const,
              image: new URL(image.url),
              mediaType: image.mimeType,
            };
          } catch {
            return {
              type: "text" as const,
              text: `[Image: ${image.url}]`,
            };
          }
        }),
      ],
    },
  ];
}
