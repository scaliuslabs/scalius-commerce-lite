export const DEFAULT_D1_RETRY_DELAYS_MS = [150, 350, 750] as const;

export function isTransientD1Error(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("D1 DB is overloaded") ||
    message.includes("Requests queued for too long") ||
    message.includes("code: 7429")
  );
}

export async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryTransientD1<T>(
  operation: (attempt: number) => Promise<T> | T,
  options: {
    delaysMs?: readonly number[];
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  const delaysMs = options.delaysMs ?? DEFAULT_D1_RETRY_DELAYS_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const delayMs = delaysMs[attempt];
      if (!isTransientD1Error(error) || delayMs === undefined) break;
      options.onRetry?.(error, attempt, delayMs);
      await wait(delayMs);
    }
  }

  throw lastError;
}
