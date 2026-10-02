// How much of one request an import batch may use. A Worker invocation has a
// wall-clock limit and a per-invocation D1 query limit (1,000 on Workers
// Paid, 50 on Free), so a batch processes items until its time budget runs
// out or D1 refuses another query, then reports how many it finished; the
// caller sends the rest again. Every item is idempotent, so an item cut off
// part-way is simply applied (or found unchanged) on the next request.

/** Default wall-clock budget per import request. */
export const IMPORT_REQUEST_BUDGET_MS = 20_000;

export class ImportBudget {
  private readonly deadline: number;

  constructor(budgetMs: number = IMPORT_REQUEST_BUDGET_MS, private readonly now: () => number = Date.now) {
    this.deadline = now() + budgetMs;
  }

  exhausted(): boolean {
    return this.now() >= this.deadline;
  }
}

function errorText(error: unknown, depth = 0): string {
  if (depth > 4 || error == null) return "";
  if (typeof error !== "object") return String(error);
  const candidate = error as { message?: unknown; cause?: unknown };
  return `${typeof candidate.message === "string" ? candidate.message : ""} ${errorText(candidate.cause, depth + 1)}`;
}

/** The Worker ran out of D1 queries or subrequests for this invocation. */
export function isWorkerLimitError(error: unknown): boolean {
  return /too many (api requests|subrequests|queries)|subrequest limit|query limit/i.test(errorText(error));
}
