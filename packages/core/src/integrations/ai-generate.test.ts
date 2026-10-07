import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AI_PORT_VERSION, PROVIDER_OPERATIONS, ProviderError, aiGenerateInputSchema, aiGenerateOutputSchema } from "@scalius/shared/plugins/providers";
import { AI_GENERATE_OUTPUT_MAX_BYTES, AiGenerateError, generateStructured } from "./ai-generate";
import type { BoundProvider } from "./provider-port";

const SECRET_PROMPT = "Eid sale for Rahima, phone 01711000000";
const schema = z.object({ headline: z.string().min(1).max(80), points: z.array(z.string()).max(3) });

/** A fake app provider: answers with `answer` (or throws / waits), and records each call. */
function fakeProvider(answer: (input: unknown, signal: AbortSignal | undefined) => Promise<unknown>) {
  const calls: Array<{ input: unknown; signal: AbortSignal | undefined }> = [];
  const provider = {
    id: "acme.ai:writer",
    label: "Acme Writer",
    generate: vi.fn(async (input: unknown, { signal }: { signal?: AbortSignal } = {}) => {
      calls.push({ input, signal });
      return answer(input, signal) as never;
    }),
  } as unknown as BoundProvider<"ai">;
  return { provider, calls };
}

const request = (extra: Partial<Parameters<typeof generateStructured>[1]> = {}) => ({
  purpose: "product.description",
  instructions: "Write a headline and up to three points.",
  prompt: SECRET_PROMPT,
  locale: "en",
  schema,
  ...extra,
});

async function failure(promise: Promise<unknown>): Promise<AiGenerateError> {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AiGenerateError);
  return error as AiGenerateError;
}

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => warn.mockClear());

/** Nothing a failure logs may carry the merchant's words or the answer. */
function expectMaskedLogs(...forbidden: string[]) {
  const logged = warn.mock.calls.flat().map(String).join("\n");
  for (const text of [SECRET_PROMPT, ...forbidden]) expect(logged).not.toContain(text);
}

describe("the AI port contract", () => {
  it("is one general operation, versioned, with a JSON Schema in and one value out", () => {
    expect(PROVIDER_OPERATIONS.ai).toEqual({ required: ["generate"], optional: ["testConnection"] });
    const input = { version: AI_PORT_VERSION, purpose: "theme.sections", instructions: "x", prompt: "y", locale: "en", schema: { type: "object" } };
    expect(aiGenerateInputSchema.safeParse(input).success).toBe(true);
    expect(aiGenerateInputSchema.safeParse({ ...input, version: 2 }).success).toBe(false);
    expect(aiGenerateInputSchema.safeParse({ ...input, purpose: "Theme Sections" }).success).toBe(false);
    expect(aiGenerateOutputSchema.safeParse({ value: { any: "json" } }).success).toBe(true);
    expect(aiGenerateOutputSchema.safeParse({ value: 1, extra: true }).success).toBe(false);
  });
});

describe("generateStructured", () => {
  it("sends the caller's schema as JSON Schema and returns the validated value", async () => {
    const { provider, calls } = fakeProvider(async () => ({ value: { headline: "Eid sale", points: ["Free delivery"] } }));
    await expect(generateStructured(provider, request())).resolves.toEqual({ headline: "Eid sale", points: ["Free delivery"] });
    const input = calls[0]!.input as Record<string, unknown>;
    expect(aiGenerateInputSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({ version: AI_PORT_VERSION, purpose: "product.description", prompt: SECRET_PROMPT, locale: "en" });
    expect(input.schema).toMatchObject({ type: "object", required: ["headline", "points"] });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends a richer JSON Schema when the caller gives one", async () => {
    const jsonSchema = { type: "object", description: "A headline" };
    const { provider, calls } = fakeProvider(async () => ({ value: { headline: "Hi", points: [] } }));
    await generateStructured(provider, request({ jsonSchema }));
    expect((calls[0]!.input as { schema: unknown }).schema).toBe(jsonSchema);
  });

  it("refuses an answer that does not fit, with the reason and no values", async () => {
    const { provider } = fakeProvider(async () => ({ value: { headline: "", points: ["a"], secret: "leak" } }));
    const error = await failure(generateStructured(provider, request()));
    expect(error.reason).toBe("invalid_output");
    expect(error.message).toContain("Acme Writer gave an answer that does not fit (headline:");
    expect(error.message).toContain("Nothing was added");
    expectMaskedLogs("leak");
    expect(warn.mock.calls[0]![0]).toMatch(/^\[ai\] product\.description via acme\.ai:writer failed: invalid_output after \d+ ms, \d+ bytes\.$/);
  });

  it("refuses an empty answer", async () => {
    const { provider } = fakeProvider(async () => ({}));
    expect((await failure(generateStructured(provider, request()))).reason).toBe("invalid_output");
  });

  it("refuses an answer larger than it reads", async () => {
    const huge = "x".repeat(AI_GENERATE_OUTPUT_MAX_BYTES);
    const { provider } = fakeProvider(async () => ({ value: { headline: "Hi", points: [huge] } }));
    const error = await failure(generateStructured(provider, request()));
    expect(error.reason).toBe("too_large");
    expect(error.message).toBe("Acme Writer answered with more than 256 KB. Ask for less.");
    expectMaskedLogs(huge.slice(0, 64));
  });

  it("stops waiting at the timeout, aborts the call and never retries", async () => {
    const { provider, calls } = fakeProvider(() => new Promise(() => {}));
    const error = await failure(generateStructured(provider, request({ timeoutMs: 20 })));
    expect(error.reason).toBe("timeout");
    expect(error.message).toBe("Acme Writer did not answer in 0 seconds. Try again, or ask for less.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal!.aborted).toBe(true);
    expectMaskedLogs();
  });

  it("stops when the caller cancels, and does not start when already cancelled", async () => {
    const { provider, calls } = fakeProvider(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = generateStructured(provider, request({ signal: controller.signal }));
    controller.abort();
    expect((await failure(pending)).reason).toBe("cancelled");
    expect(calls[0]!.signal!.aborted).toBe(true);
    expect((await failure(generateStructured(provider, request({ signal: controller.signal })))).reason).toBe("cancelled");
    expect(calls).toHaveLength(1);
  });

  it("shows a provider's safe message, and a plain one for anything else", async () => {
    const typed = fakeProvider(async () => { throw new ProviderError("misconfigured", "The API key is not valid."); });
    const first = await failure(generateStructured(typed.provider, request()));
    expect(first).toMatchObject({ reason: "provider", message: "Acme Writer: The API key is not valid." });
    const raw = fakeProvider(async () => { throw new Error(`upstream 500 for ${SECRET_PROMPT}`); });
    const second = await failure(generateStructured(raw.provider, request()));
    expect(second).toMatchObject({ reason: "provider", message: "Acme Writer could not answer. Try again." });
    expect(raw.calls).toHaveLength(1);
    expectMaskedLogs("upstream 500");
  });
});
