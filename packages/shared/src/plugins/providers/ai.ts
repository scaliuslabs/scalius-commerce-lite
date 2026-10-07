// The AI port: the platform's one general port for generated text and
// structured data. Core has no model, no vendor and no key: an app provides
// the port (the store's own key in the app's settings, or a model the app
// runs itself).
//
// `generate` takes host-written instructions, the merchant's words and a
// JSON Schema, and returns one JSON value that should match the schema. The
// host never trusts the answer: each consumer validates the value against
// its own schemas before it uses it, and nothing generated is saved until
// the merchant saves it.
//
// Consumers name themselves in `purpose`. The first is `theme.sections`
// (the theme editor's "Draft with AI"). Product descriptions, SEO fields,
// alt text, inbox replies and analytics questions are planned on the same
// port, and the `translation` kind is to fold into it.

import { z } from "zod";

export const AI_GENERATE_PROMPT_MAX = 4_000;
export const AI_GENERATE_INSTRUCTIONS_MAX = 8_000;

/** A consumer's name: `theme.sections`, `product.description`, … */
export const aiPurposeSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,30}(\.[a-z][a-z0-9_-]{0,30}){0,3}$/);

export const aiGenerateInputSchema = z.object({
  /** Which consumer asks (for the provider's routing, limits and logs). */
  purpose: aiPurposeSchema,
  /** What the host asks for and the rules of the answer (host-written, never the merchant's). */
  instructions: z.string().trim().min(1).max(AI_GENERATE_INSTRUCTIONS_MAX),
  /** What the merchant asked for, in their words. */
  prompt: z.string().trim().min(1).max(AI_GENERATE_PROMPT_MAX),
  /** The language the words of the answer should be in (ISO 639-1). */
  locale: z.string().regex(/^[a-z]{2}$/),
  /** A JSON Schema (draft 2020-12) the answer's `value` must match. */
  schema: z.record(z.string(), z.unknown()),
  /** Most output tokens the host wants spent (the provider may use fewer). */
  maxOutputTokens: z.number().int().min(16).max(32_000).optional(),
}).strict();

export const aiGenerateOutputSchema = z.object({
  /** The answer: one JSON value meant to match the input's schema (the host validates it). */
  value: z.unknown(),
}).strict();

export const AI_PORT = {
  generate: { input: aiGenerateInputSchema, output: aiGenerateOutputSchema },
} as const;

export type AiGenerateInput = z.infer<typeof aiGenerateInputSchema>;
export type AiGenerateOutput = z.infer<typeof aiGenerateOutputSchema>;
