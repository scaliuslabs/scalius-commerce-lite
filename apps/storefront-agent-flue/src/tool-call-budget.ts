export const STOREFRONT_TOOL_CALL_LIMIT = 4;

export class StorefrontToolCallBudgetExceededError extends Error {
  constructor() {
    super(
      `Storefront assistant tool-call limit (${STOREFRONT_TOOL_CALL_LIMIT}) exceeded for this submission.`,
    );
    this.name = "StorefrontToolCallBudgetExceededError";
  }
}

export interface StorefrontToolCallBudget {
  consume(signal?: AbortSignal): void;
}

/** One config is created for one Flue submission attempt. Flue may replace the
 * AbortSignal between prompt/continue/retry phases, so the counter belongs to
 * this closure and the signal is used only for cancellation.
 */
export function createStorefrontToolCallBudget(): StorefrontToolCallBudget {
  let calls = 0;

  return Object.freeze({
    consume(signal?: AbortSignal) {
      if (signal?.aborted) {
        throw (
          signal.reason ??
          new DOMException("Storefront tool call was aborted", "AbortError")
        );
      }
      if (calls >= STOREFRONT_TOOL_CALL_LIMIT) {
        throw new StorefrontToolCallBudgetExceededError();
      }
      calls += 1;
    },
  });
}
