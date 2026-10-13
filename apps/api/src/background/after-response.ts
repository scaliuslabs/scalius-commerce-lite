// Background work without a queue: the first attempt of work whose durable
// row (an outbox, a delivery, a claimed payment event, an OTP receipt, a
// cursor) the scheduled tick also drains. It runs after the response in the
// same invocation (`waitUntil`) and shares that invocation's limits, so every
// drain is bounded by `planLimits().background` and leaves the rest due.
import { getOptionalExecutionContext, type WaitUntilExecutionContext } from "../utils/execution-context";

export type BackgroundCaller = { executionCtx?: WaitUntilExecutionContext } | WaitUntilExecutionContext | undefined;

function contextOf(caller: BackgroundCaller): WaitUntilExecutionContext | undefined {
  if (!caller) return undefined;
  if ("waitUntil" in caller && typeof caller.waitUntil === "function") return caller;
  return getOptionalExecutionContext(caller as { executionCtx?: WaitUntilExecutionContext });
}

/**
 * Runs `work` after the response, or before returning when the caller has no
 * execution context (a test, a caller outside a request). Never throws: a
 * failure is logged by label and error name only (no provider text or PII);
 * its durable row records what is left to do.
 */
export async function afterResponse(caller: BackgroundCaller, label: string, work: () => Promise<unknown>): Promise<void> {
  const task = Promise.resolve()
    .then(work)
    .then(() => undefined, (error: unknown) => {
      console.warn(`[background] ${label} failed`, { error: error instanceof Error ? error.name : typeof error });
    });
  const ctx = contextOf(caller);
  if (ctx) ctx.waitUntil(task);
  else await task;
}

/** The caller's execution context, or one whose background work nobody awaits (tests, detached callers). */
export function executionContextOf(caller: BackgroundCaller): ExecutionContext {
  const ctx = contextOf(caller);
  if (ctx) return ctx as ExecutionContext;
  return { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
}
