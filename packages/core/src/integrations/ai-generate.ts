// One structured generation through the AI port (`generate`), the way every
// consumer calls it: product descriptions, SEO fields and alt text later,
// the theme editor's Draft with AI first.
//
// - The caller gives a zod schema. Its JSON Schema goes to the provider, and
//   the answer is validated against the zod schema before anything uses it.
//   An answer that does not fit is refused with a plain reason.
// - One attempt, bounded: a timeout, the caller's cancellation, a cap on the
//   answer's size. No retries: the merchant asks again.
// - Failures are logged with masked metadata only (purpose, provider id,
//   reason, time, size). Prompts, instructions and answers are never logged:
//   they can hold merchant and buyer data.

import { z } from "zod";
import { AI_PORT_VERSION, providerErrorOf, type AiGenerateInput } from "@scalius/shared/plugins/providers";
import type { BoundProvider } from "./provider-port";

/** Longest wait for an answer. The plugin host's own wall-time limit also applies. */
export const AI_GENERATE_TIMEOUT_MS = 30_000;
/** Largest answer (its JSON) a consumer reads. */
export const AI_GENERATE_OUTPUT_MAX_BYTES = 256 * 1024;

export type AiGenerateFailure = "timeout" | "cancelled" | "provider" | "too_large" | "invalid_output";

/** Why a generation gave nothing usable; `message` is safe to show the merchant. */
export class AiGenerateError extends Error {
  readonly reason: AiGenerateFailure;
  constructor(reason: AiGenerateFailure, message: string) {
    super(message);
    this.name = "AiGenerateError";
    this.reason = reason;
  }
}

export interface AiStructuredRequest<Schema extends z.ZodType> {
  purpose: AiGenerateInput["purpose"];
  instructions: string;
  prompt: string;
  locale: string;
  /** What the answer must be. */
  schema: Schema;
  /**
   * The JSON Schema sent to the provider, when the caller writes a richer one
   * (descriptions per choice). It must describe no more than `schema` accepts.
   * Default: `schema` as JSON Schema.
   */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  /** The caller's cancellation (the request ended). */
  signal?: AbortSignal;
  /** Overrides AI_GENERATE_TIMEOUT_MS (tests). */
  timeoutMs?: number;
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/** The first problem of a refused answer, as a short path and message (no values). */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "it does not match the requested shape";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export async function generateStructured<Schema extends z.ZodType>(
  provider: BoundProvider<"ai">,
  request: AiStructuredRequest<Schema>,
): Promise<z.output<Schema>> {
  const started = Date.now();
  const fail = (reason: AiGenerateFailure, message: string, bytes?: number): never => {
    // Masked metadata only: never the prompt, the instructions or the answer.
    console.warn(`[ai] ${request.purpose} via ${provider.id} failed: ${reason} after ${Date.now() - started} ms${bytes === undefined ? "" : `, ${bytes} bytes`}.`);
    throw new AiGenerateError(reason, message);
  };
  if (request.signal?.aborted) fail("cancelled", "Stopped.");

  const timeoutMs = request.timeoutMs ?? AI_GENERATE_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  const cancel = () => controller.abort(new Error("cancelled"));
  request.signal?.addEventListener("abort", cancel, { once: true });
  // A provider that ignores the signal still loses the race.
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });

  let output: { value: unknown };
  try {
    output = await Promise.race([
      provider.generate({
        version: AI_PORT_VERSION,
        purpose: request.purpose,
        instructions: request.instructions,
        prompt: request.prompt,
        locale: request.locale,
        schema: request.jsonSchema ?? (z.toJSONSchema(request.schema, { unrepresentable: "any" }) as Record<string, unknown>),
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
      }, { signal: controller.signal }),
      stopped,
    ]);
  } catch (error) {
    if (timedOut) return fail("timeout", `${provider.label} did not answer in ${Math.round(timeoutMs / 1000)} seconds. Try again, or ask for less.`);
    if (controller.signal.aborted) return fail("cancelled", "Stopped.");
    const providerError = providerErrorOf(error);
    return fail("provider", providerError ? `${provider.label}: ${providerError.message}` : `${provider.label} could not answer. Try again.`);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", cancel);
  }

  const value = (output as { value?: unknown } | null)?.value;
  if (value === undefined) return fail("invalid_output", `${provider.label} gave no answer. Try other words.`);
  const bytes = byteLength(JSON.stringify(value) ?? "");
  if (bytes > AI_GENERATE_OUTPUT_MAX_BYTES) {
    return fail("too_large", `${provider.label} answered with more than ${AI_GENERATE_OUTPUT_MAX_BYTES / 1024} KB. Ask for less.`, bytes);
  }
  const parsed = request.schema.safeParse(value);
  if (!parsed.success) {
    return fail("invalid_output", `${provider.label} gave an answer that does not fit (${firstIssue(parsed.error)}). Nothing was added. Try other words.`, bytes);
  }
  return parsed.data;
}
