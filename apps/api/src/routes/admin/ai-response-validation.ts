import { z } from "zod";
import {
  GENERATION_CONFIG,
  ERROR_MESSAGES,
} from "@scalius/core/modules/ai";
import { parseJSONSafely, validateWidgetJSON } from "@scalius/shared/json-repair";
import {
  parseTagBasedResponse,
  validateParsedWidget,
  type ParsedWidget,
} from "@scalius/shared/tag-parser";
import { ValidationError } from "../../utils/api-error";

export const widgetOutputSchema = z.object({
  html: z.string().min(1),
  css: z.string().optional(),
});

export const stagedPlanOutputSchema = z
  .object({
    totalSections: z
      .number()
      .int()
      .min(GENERATION_CONFIG.stagedGeneration.minSections)
      .max(GENERATION_CONFIG.stagedGeneration.maxSections),
    sectionDescriptions: z
      .array(z.string().min(1).max(160))
      .min(GENERATION_CONFIG.stagedGeneration.minSections)
      .max(GENERATION_CONFIG.stagedGeneration.maxSections),
    estimatedTokens: z.number().int().positive().optional(),
  })
  .refine((plan) => plan.sectionDescriptions.length === plan.totalSections, {
    message: "Section description count must match totalSections.",
    path: ["sectionDescriptions"],
  });

export type WidgetOutput = z.infer<typeof widgetOutputSchema>;
export type StagedPlanOutput = z.infer<typeof stagedPlanOutputSchema>;

function widgetOutputToTaggedText(output: WidgetOutput): string {
  return `<htmljs>\n${output.html.trim()}\n</htmljs>\n\n<css>\n${(output.css ?? "").trim()}\n</css>`;
}

function assertGeneratedWidgetIsSafe(widget: ParsedWidget): void {
  const parsedValidation = validateParsedWidget(widget);
  if (!parsedValidation.valid) {
    throw new ValidationError(
      ERROR_MESSAGES.jsonParseFailed,
      { reason: parsedValidation.error },
    );
  }

  const jsonValidation = validateWidgetJSON({
    html: widget.html,
    css: widget.css,
  });
  if (!jsonValidation.valid) {
    throw new ValidationError(
      ERROR_MESSAGES.jsonParseFailed,
      { reason: jsonValidation.error },
    );
  }

  if (/<\/?script\b/i.test(widget.html)) {
    throw new ValidationError(
      "AI response included script tags. Widgets must use HTML and CSS only.",
    );
  }
}

function parseWidgetJson(text: string): ParsedWidget | null {
  const jsonParsed = parseJSONSafely(text);
  if (!jsonParsed.success || !jsonParsed.data) return null;

  const validation = validateWidgetJSON(jsonParsed.data);
  if (!validation.valid) {
    throw new ValidationError(
      ERROR_MESSAGES.jsonParseFailed,
      { reason: validation.error },
    );
  }

  const data = jsonParsed.data as Record<string, unknown>;
  return {
    html: String(data.html || data.htmljs || ""),
    css: String(data.css || data.cssContent || ""),
    raw: text,
  };
}

export function normalizeWidgetGenerationText(text: string): string {
  const tagResult = parseTagBasedResponse(text);
  const widget = tagResult.success && tagResult.data
    ? tagResult.data
    : parseWidgetJson(text);

  if (!widget) {
    throw new ValidationError(
      ERROR_MESSAGES.jsonParseFailed,
      { reason: tagResult.error || "No supported widget response format found." },
    );
  }

  assertGeneratedWidgetIsSafe(widget);
  return widgetOutputToTaggedText(widget);
}

export function normalizeWidgetOutput(output: WidgetOutput): string {
  return normalizeWidgetGenerationText(widgetOutputToTaggedText(output));
}

export function normalizeStagedPlanText(text: string): string {
  const parsed = parseJSONSafely(text);
  if (!parsed.success) {
    throw new ValidationError(
      "AI response did not include a valid staged generation plan.",
      { reason: parsed.error },
    );
  }

  const plan = stagedPlanOutputSchema.safeParse(parsed.data);
  if (!plan.success) {
    throw new ValidationError(
      "AI response did not include a valid staged generation plan.",
      { issues: plan.error.issues },
    );
  }

  return JSON.stringify(plan.data);
}

export function normalizeStagedPlanOutput(output: StagedPlanOutput): string {
  const plan = stagedPlanOutputSchema.safeParse(output);
  if (!plan.success) {
    throw new ValidationError(
      "AI response did not include a valid staged generation plan.",
      { issues: plan.error.issues },
    );
  }

  return JSON.stringify(plan.data);
}
