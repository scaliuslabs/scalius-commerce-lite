/**
 * AI Context Schema - Type-safe validation for widget AI context
 *
 * This schema defines the structure of data saved in the widget's aiContext field.
 * It includes both generation context and improvement history for full persistence.
 */

import { z } from 'zod';

// Media file schema
export const MediaFileSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  filename: z.string(),
  size: z.number(),
  createdAt: z.date().or(z.string()).transform(val =>
    typeof val === 'string' ? new Date(val) : val
  ),
});

// Product reference schema (minimal data for context)
export const ProductReferenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  primaryImage: z.string().url().nullable(),
});

// Category reference schema
export const CategoryReferenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
});

// Improvement history entry
export const ImprovementHistoryEntrySchema = z.object({
  section: z.number().optional(),
  prompt: z.string(),
  timestamp: z.number(),
  modelUsed: z.string().optional(),
});

// Staged generation section
export const StagedSectionSchema = z.object({
  html: z.string(),
  css: z.string(),
  sectionIndex: z.number(),
  description: z.string().optional(),
  id: z.string(),
  timestamp: z.number(),
});

// Staged generation plan
export const StagedGenerationPlanSchema = z.object({
  totalSections: z.number(),
  sectionDescriptions: z.array(z.string()),
  estimatedTokens: z.number().optional(),
});

// Main AI Context Schema
export const AiContextSchema = z.object({
  // Generation settings
  promptType: z.enum(['widget', 'landing-page', 'collection']).default('widget'),
  preferredAiModel: z.string().optional(),
  useStagedMode: z.boolean().default(false),

  // Context data
  savedImages: z.array(MediaFileSchema).default([]),
  savedProducts: z.array(ProductReferenceSchema).default([]),
  savedCategories: z.array(CategoryReferenceSchema).default([]),
  allCategoriesSelected: z.boolean().default(false),

  // Staged generation data (if used)
  stagedPlan: StagedGenerationPlanSchema.optional(),
  stagedSections: z.array(StagedSectionSchema).default([]),

  // Improvement history
  improvementHistory: z.array(ImprovementHistoryEntrySchema).default([]),

  // Metadata
  createdAt: z.number().optional(),
  lastModified: z.number().optional(),
});

export type AiContext = z.infer<typeof AiContextSchema>;
export type MediaFile = z.infer<typeof MediaFileSchema>;
export type ProductReference = z.infer<typeof ProductReferenceSchema>;
export type CategoryReference = z.infer<typeof CategoryReferenceSchema>;
export type ImprovementHistoryEntry = z.infer<typeof ImprovementHistoryEntrySchema>;
export type StagedSection = z.infer<typeof StagedSectionSchema>;
export type StagedGenerationPlan = z.infer<typeof StagedGenerationPlanSchema>;

/**
 * Parse and validate AI context from database
 * Handles both old and new formats gracefully
 */
export function parseAiContext(jsonString: string | null | undefined): AiContext {
  if (!jsonString) {
    return AiContextSchema.parse({});
  }

  try {
    let parsed = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;

    // Handle double-stringified JSON (legacy data)
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }

    // If still not an object, return empty context
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('AI context is not an object after parsing, using empty context');
      return AiContextSchema.parse({});
    }

    // Use safeParse for graceful handling of old data
    const result = AiContextSchema.safeParse(parsed);

    if (result.success) {
      return result.data;
    } else {
      console.warn('AI context validation failed, attempting recovery:', result.error.issues);
      // Try to recover with defaults for missing/invalid fields
      const recovered = {
        promptType: parsed.promptType || 'widget',
        preferredAiModel: parsed.preferredAiModel || undefined,
        useStagedMode: parsed.useStagedMode || false,
        savedImages: Array.isArray(parsed.savedImages) ? parsed.savedImages : [],
        savedProducts: Array.isArray(parsed.savedProducts) ? parsed.savedProducts : [],
        savedCategories: Array.isArray(parsed.savedCategories) ? parsed.savedCategories : [],
        allCategoriesSelected: parsed.allCategoriesSelected || false,
        stagedPlan: parsed.stagedPlan || undefined,
        stagedSections: Array.isArray(parsed.stagedSections) ? parsed.stagedSections : [],
        improvementHistory: Array.isArray(parsed.improvementHistory) ? parsed.improvementHistory : [],
        createdAt: parsed.createdAt || Date.now(),
        lastModified: parsed.lastModified || Date.now(),
      };

      // Validate recovered data
      const recoveredResult = AiContextSchema.safeParse(recovered);
      if (recoveredResult.success) {
        return recoveredResult.data;
      }

      // If still fails, return minimal valid context
      console.error('Could not recover AI context, using empty context');
      return AiContextSchema.parse({});
    }
  } catch (error) {
    console.error('Failed to parse AI context:', error);
    // Return default schema instead of throwing
    return AiContextSchema.parse({});
  }
}

/**
 * Serialize AI context for database storage
 */
export function serializeAiContext(context: Partial<AiContext>): string {
  const validated = AiContextSchema.parse({
    ...context,
    lastModified: Date.now(),
  });
  return JSON.stringify(validated);
}

/**
 * Merge new context data with existing context
 */
export function mergeAiContext(
  existing: Partial<AiContext>,
  updates: Partial<AiContext>
): AiContext {
  return AiContextSchema.parse({
    ...existing,
    ...updates,
    lastModified: Date.now(),
  });
}
