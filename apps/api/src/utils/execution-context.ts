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
