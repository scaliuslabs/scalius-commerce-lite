import { z } from 'zod';
import { GENERATION_CONFIG, ERROR_MESSAGES } from '@scalius/core/modules/ai';
import { sanitizeCssForStyleElement } from '@scalius/shared/css-sanitize';
import { sanitizeHtml } from '@scalius/shared/html-sanitize';
import { parseJSONSafely, validateWidgetJSON } from '@scalius/shared/json-repair';
import { parseTagBasedResponse, validateParsedWidget, type ParsedWidget } from '@scalius/shared/tag-parser';
import { ValidationError } from '../../utils/api-error';

export const widgetOutputSchema = z
  .object({
    html: z.string().min(1).describe('Complete widget HTML fragment. Do not include script tags or markdown fences.'),
    css: z.string().describe('Complete widget stylesheet. Use an empty string if no CSS is needed.'),
  })
  .strict()
  .describe('Validated storefront widget code returned by the AI generator.');

export const stagedPlanOutputSchema = z
  .object({
    totalSections: z
      .number()
      .int()
      .min(GENERATION_CONFIG.stagedGeneration.minSections)
      .max(GENERATION_CONFIG.stagedGeneration.maxSections)
      .describe('Number of widget sections to generate.'),
    sectionDescriptions: z
      .array(z.string().min(1).max(160))
      .min(GENERATION_CONFIG.stagedGeneration.minSections)
      .max(GENERATION_CONFIG.stagedGeneration.maxSections)
      .describe('Short storefront-facing purpose for each section, in generation order.'),
    compositionBrief: z
      .string()
      .min(1)
      .max(500)
      .describe('One-sentence description of the complete widget as a single composition.'),
    sharedDesignSystem: z
      .string()
      .min(1)
      .max(500)
      .describe('Shared visual system that every staged section must reuse.'),
    spacingStrategy: z
      .string()
      .min(1)
      .max(360)
      .describe('How adjacent sections connect without unintended whitespace.'),
    sectionContinuity: z
      .array(z.string().min(1).max(200))
      .min(GENERATION_CONFIG.stagedGeneration.minSections)
      .max(GENERATION_CONFIG.stagedGeneration.maxSections)
      .describe('Per-section instruction for how it connects to surrounding sections.'),
    estimatedTokens: z.number().int().positive().describe('Estimated output tokens for the complete widget.'),
  })
  .strict()
  .describe('Section plan for staged storefront widget generation.')
  .refine((plan) => plan.sectionDescriptions.length === plan.totalSections, {
    message: 'Section description count must match totalSections.',
    path: ['sectionDescriptions'],
  })
  .refine((plan) => plan.sectionContinuity.length === plan.totalSections, {
    message: 'Section continuity count must match totalSections.',
    path: ['sectionContinuity'],
  });

export type WidgetOutput = z.infer<typeof widgetOutputSchema>;
export type StagedPlanOutput = z.infer<typeof stagedPlanOutputSchema>;

export const widgetOutputObjectSpec = {
  name: 'WidgetGeneration',
  description:
    'Return production-ready ecommerce widget HTML and CSS only. The HTML must be a fragment without scripts; the CSS must be safe for a style element.',
  schema: widgetOutputSchema,
} as const;

export const stagedPlanOutputObjectSpec = {
  name: 'WidgetGenerationPlan',
  description: 'Return a concise staged generation plan for one ecommerce storefront widget.',
  schema: stagedPlanOutputSchema,
} as const;

function widgetOutputToTaggedText(output: WidgetOutput): string {
  return `<htmljs>\n${output.html.trim()}\n</htmljs>\n\n<css>\n${(output.css ?? '').trim()}\n</css>`;
}

function assertGeneratedWidgetIsSafe(widget: ParsedWidget): void {
  const parsedValidation = validateParsedWidget(widget);
  if (!parsedValidation.valid) {
    throw new ValidationError(ERROR_MESSAGES.jsonParseFailed, {
      reason: parsedValidation.error,
    });
  }

  const jsonValidation = validateWidgetJSON({
    html: widget.html,
    css: widget.css,
  });
  if (!jsonValidation.valid) {
    throw new ValidationError(ERROR_MESSAGES.jsonParseFailed, {
      reason: jsonValidation.error,
    });
  }

  if (/<\/?script\b/i.test(widget.html)) {
    throw new ValidationError('AI response included script tags. Widgets must use HTML and CSS only.');
  }
}

function sanitizeGeneratedWidget(widget: ParsedWidget): ParsedWidget {
  const sanitized = {
    html: sanitizeHtml(widget.html),
    css: sanitizeCssForStyleElement(widget.css),
    raw: widget.raw,
  };

  assertGeneratedWidgetIsSafe(sanitized);
  return sanitized;
}

function parseWidgetJson(text: string): ParsedWidget | null {
  const jsonParsed = parseJSONSafely(text);
  if (!jsonParsed.success || !jsonParsed.data) return null;

  const validation = validateWidgetJSON(jsonParsed.data);
  if (!validation.valid) {
    throw new ValidationError(ERROR_MESSAGES.jsonParseFailed, {
      reason: validation.error,
    });
  }

  const data = jsonParsed.data as Record<string, unknown>;
  return {
    html: String(data.html || data.htmljs || ''),
    css: String(data.css || data.cssContent || ''),
    raw: text,
  };
}

export function normalizeWidgetGenerationText(text: string): string {
  const tagResult = parseTagBasedResponse(text);
  const widget = tagResult.success && tagResult.data ? tagResult.data : parseWidgetJson(text);

  if (!widget) {
    throw new ValidationError(ERROR_MESSAGES.jsonParseFailed, {
      reason: tagResult.error || 'No supported widget response format found.',
    });
  }

  assertGeneratedWidgetIsSafe(widget);
  return widgetOutputToTaggedText(sanitizeGeneratedWidget(widget));
}

export function normalizeWidgetOutput(output: WidgetOutput): string {
  return normalizeWidgetGenerationText(widgetOutputToTaggedText(output));
}

export function normalizeStagedPlanText(text: string): string {
  const parsed = parseJSONSafely(text);
  if (!parsed.success) {
    throw new ValidationError('AI response did not include a valid staged generation plan.', { reason: parsed.error });
  }

  const planData = parsed.data as Record<string, unknown>;
  const normalizeTextField = (value: unknown, fallback: string, maxLength: number) => {
    const text = String(value || fallback).trim();
    return (text || fallback).slice(0, maxLength);
  };
  const rawDescriptions = Array.isArray(planData.sectionDescriptions) ? planData.sectionDescriptions : [];
  const sectionDescriptions = rawDescriptions
    .map((description, index) => String(description || `Section ${index + 1}`).trim())
    .filter(Boolean)
    .slice(0, GENERATION_CONFIG.stagedGeneration.maxSections);
  const rawTotalSections = Number(planData.totalSections);
  const totalSections = Number.isFinite(rawTotalSections)
    ? Math.min(
        GENERATION_CONFIG.stagedGeneration.maxSections,
        Math.max(GENERATION_CONFIG.stagedGeneration.minSections, Math.round(rawTotalSections)),
      )
    : Math.min(
        GENERATION_CONFIG.stagedGeneration.maxSections,
        Math.max(GENERATION_CONFIG.stagedGeneration.minSections, sectionDescriptions.length),
      );
  const normalizedDescriptions = sectionDescriptions
    .slice(0, totalSections)
    .map((description, index) => description.slice(0, 160) || `Section ${index + 1}`);

  while (normalizedDescriptions.length < totalSections) {
    normalizedDescriptions.push(`Section ${normalizedDescriptions.length + 1}`);
  }

  const compositionBrief = normalizeTextField(
    planData.compositionBrief,
    'One continuous storefront widget composition with a clear opening, supporting merchandising, and conversion close.',
    500,
  );
  const sharedDesignSystem = normalizeTextField(
    planData.sharedDesignSystem,
    'Reuse one color palette, type scale, image treatment, card style, button language, and responsive spacing rhythm across every section.',
    500,
  );
  const spacingStrategy = normalizeTextField(
    planData.spacingStrategy,
    'The final wrapper places sections with zero external gap; each section uses internal padding and intentional dividers or shared backgrounds to connect.',
    360,
  );
  const rawContinuity = Array.isArray(planData.sectionContinuity) ? planData.sectionContinuity : [];
  const normalizedContinuity = rawContinuity
    .slice(0, totalSections)
    .map((instruction, index) =>
      normalizeTextField(
        instruction,
        index === 0
          ? 'Establish the shared visual system and hand off naturally to the next section.'
          : 'Continue the shared visual system from the previous section without external spacing.',
        200,
      ),
    );

  while (normalizedContinuity.length < totalSections) {
    normalizedContinuity.push(
      normalizedContinuity.length === 0
        ? 'Establish the shared visual system and hand off naturally to the next section.'
        : 'Continue the shared visual system from the previous section without external spacing.',
    );
  }

  const estimatedTokens = Number.isFinite(Number(planData.estimatedTokens))
    ? Math.max(1, Math.round(Number(planData.estimatedTokens)))
    : Math.max(800, totalSections * 700);

  const normalizedPlan = {
    totalSections,
    sectionDescriptions: normalizedDescriptions,
    compositionBrief,
    sharedDesignSystem,
    spacingStrategy,
    sectionContinuity: normalizedContinuity,
    estimatedTokens,
  };

  const plan = stagedPlanOutputSchema.safeParse(normalizedPlan);
  if (!plan.success) {
    throw new ValidationError('AI response did not include a valid staged generation plan.', {
      issues: plan.error.issues,
    });
  }

  return JSON.stringify(plan.data);
}

export function normalizeStagedPlanOutput(output: StagedPlanOutput): string {
  const plan = stagedPlanOutputSchema.safeParse(output);
  if (!plan.success) {
    throw new ValidationError('AI response did not include a valid staged generation plan.', {
      issues: plan.error.issues,
    });
  }

  return JSON.stringify(plan.data);
}
