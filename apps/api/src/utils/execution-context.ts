export type WaitUntilExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

/** Hono throws when no Worker execution context was supplied (such as a local test). */
export function getOptionalExecutionContext(c: {
  executionCtx?: WaitUntilExecutionContext;
}): WaitUntilExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * A context for work started with no request's own (a test, a caller outside a request): what it hands to
 * `waitUntil` runs detached. Where the test registry is installed (scripts/test-background.mjs), it tracks that work,
 * so no test ends with it still running; nothing else reads the hook.
 */
export function detachedExecutionContext(): ExecutionContext {
  const track = (globalThis as Record<symbol, unknown>)[Symbol.for("scalius.test.background.track")];
  return {
    waitUntil: (promise: Promise<unknown>) => { if (typeof track === "function") track(promise); },
    passThroughOnException: () => undefined,
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}
