/**
 * One request repeated after a failure in transit: no connection, a timeout,
 * a 5xx or a 429. A refusal (4xx) is the answer and is never repeated. A
 * caller's abort ends the request at once and throws, with no repeat.
 */
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

export async function fetchWithTransientRetry(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  delays: readonly number[],
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const attemptSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const delay = delays[attempt];
    try {
      const response = await fetcher(url, { ...init, signal: attemptSignal });
      if ((response.status >= 500 || response.status === 429) && delay !== undefined) {
        await wait(delay, signal);
        continue;
      }
      return response;
    } catch (error) {
      if (signal?.aborted || delay === undefined) throw error;
      await wait(delay, signal);
    }
  }
}
