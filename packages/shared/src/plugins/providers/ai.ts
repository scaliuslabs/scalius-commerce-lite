// The AI port: a model an app connects (the store's own key, the app's
// settings) that drafts content for the merchant to review. The platform
// has no built-in provider and no key of its own; an app provides one.
//
// `draftSections` turns the merchant's words into theme sections for the
// theme editor's "Draft with AI": the host sends the section types the page
// may use, each with its settings' JSON Schema, and validates every section
// the provider returns against the theme's own section schemas. An invalid
// section never reaches the draft, and nothing the provider returns is saved
// until the merchant's editor saves it (marked as an AI draft until opened).

import { z } from "zod";

/** Most sections one draft returns. */
export const AI_DRAFT_SECTIONS_MAX = 8;
export const AI_DRAFT_PROMPT_MAX = 2_000;

export const aiDraftSectionsInputSchema = z.object({
  /** What the merchant asked for, in their words. */
  prompt: z.string().trim().min(1).max(AI_DRAFT_PROMPT_MAX),
  /** The store language the words should be in (ISO 639-1). */
  locale: z.string().regex(/^[a-z]{2}$/),
  /** The page the sections are for. */
  page: z.enum(["home", "landing", "product", "collection", "cart", "page"]),
  /** Most sections to return. */
  limit: z.number().int().min(1).max(AI_DRAFT_SECTIONS_MAX),
  /** The section types the page may use: each with what it is for and its settings' JSON Schema. */
  sectionTypes: z.array(z.object({
    type: z.string().min(1).max(40),
    description: z.string().max(300),
    settings: z.record(z.string(), z.unknown()),
  }).strict()).min(1).max(40),
}).strict();

export const aiDraftSectionsOutputSchema = z.object({
  /** Each `{ type, settings }` (an `id` is optional: the host assigns one). */
  sections: z.array(z.record(z.string(), z.unknown())).max(AI_DRAFT_SECTIONS_MAX),
  /** One short line for the merchant (what the draft did, what to check). */
  note: z.string().max(500).optional(),
}).strict();

export const AI_PORT = {
  draftSections: { input: aiDraftSectionsInputSchema, output: aiDraftSectionsOutputSchema },
} as const;

export type AiDraftSectionsInput = z.infer<typeof aiDraftSectionsInputSchema>;
export type AiDraftSectionsOutput = z.infer<typeof aiDraftSectionsOutputSchema>;
