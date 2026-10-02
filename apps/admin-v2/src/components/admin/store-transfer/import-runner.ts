// Sends import items to the API in bounded batches and keeps the progress in
// the page. Every batch endpoint is idempotent and may stop early (its time
// budget or the Worker's query limit); the runner then sends the rest again
// and halves the batch size, so the same code works on a small Workers Free
// account and a busy paid one. Network errors and 5xx answers are retried
// with backoff; a 4xx (a bad row the schema let through, a permission) stops
// the run with that error.

/** One batch's answer (the import endpoints all report these three). */
export interface BatchResponse<R> {
  results: R[];
  processed: number;
  stoppedEarly: boolean;
}

export interface RunProgress<R> {
  done: number;
  total: number;
  results: readonly R[];
}

export class ImportRunError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "ImportRunError";
  }
}

const RETRYABLE = (status: number | null) => status === null || status === 408 || status === 429 || status >= 500;

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

/**
 * Sends `items` in batches of at most `size` items and `maxBytes` of JSON,
 * collecting results in item order. Stops (completed: false) when `signal`
 * aborts between batches.
 */
export async function runInBatches<I, R>(
  items: readonly I[],
  options: {
    send: (batch: I[]) => Promise<BatchResponse<R>>;
    size: number;
    maxBytes?: number;
    retries?: number;
    signal?: AbortSignal;
    onProgress?: (progress: RunProgress<R>) => void;
    /** Milliseconds before retry n (tests pass 0). */
    backoff?: (attempt: number) => number;
  },
): Promise<{ results: R[]; completed: boolean }> {
  const results: R[] = [];
  const maxBytes = options.maxBytes ?? 768 * 1024;
  const retries = options.retries ?? 4;
  const backoff = options.backoff ?? ((attempt) => Math.min(8000, 1000 * 2 ** attempt));
  let size = Math.max(1, options.size);
  let index = 0;
  let stalls = 0;
  while (index < items.length) {
    if (options.signal?.aborted) return { results, completed: false };
    // Take up to `size` items, fewer when they would pass the byte ceiling.
    const batch: I[] = [];
    let bytes = 2;
    for (let next = index; next < items.length && batch.length < size; next += 1) {
      const itemBytes = JSON.stringify(items[next]).length + 1;
      if (batch.length > 0 && bytes + itemBytes > maxBytes) break;
      batch.push(items[next]!);
      bytes += itemBytes;
    }
    let response: BatchResponse<R> | null = null;
    for (let attempt = 0; response === null; attempt += 1) {
      try {
        response = await options.send(batch);
      } catch (error) {
        const status = statusOf(error);
        if (!RETRYABLE(status) || attempt >= retries || options.signal?.aborted) {
          throw new ImportRunError(error instanceof Error ? error.message : "The import request failed.", status);
        }
        // A timeout or an overloaded Worker: smaller batches next time.
        if (status === null || status >= 500) size = Math.max(1, Math.floor(size / 2));
        await wait(backoff(attempt), options.signal);
      }
    }
    const processed = Math.min(response.processed, batch.length);
    results.push(...response.results.slice(0, processed));
    index += processed;
    // The server finished what it could: send at most that much next time.
    if (processed < batch.length) size = Math.max(1, processed || Math.floor(size / 2));
    else if (response.stoppedEarly) size = Math.max(1, Math.floor(size / 2));
    if (processed === 0) {
      stalls += 1;
      if (stalls > retries) throw new ImportRunError("The server made no progress on this batch. Try again in a minute.", null);
      await wait(backoff(stalls), options.signal);
    } else {
      stalls = 0;
    }
    options.onProgress?.({ done: index, total: items.length, results });
  }
  return { results, completed: true };
}

/** Runs `worker` over `jobs` with at most `concurrency` in flight; results keep job order. */
export async function runPool<J, R>(
  jobs: readonly J[],
  concurrency: number,
  worker: (job: J) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(jobs.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, async () => {
    while (next < jobs.length && !signal?.aborted) {
      const index = next++;
      results[index] = await worker(jobs[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Splits a product's images into requests of at most `perRequest` images. */
export function chunkImageJobs<T extends { productId: string; images: readonly unknown[] }>(jobs: readonly T[], perRequest: number): T[] {
  const chunks: T[] = [];
  for (const job of jobs) {
    for (let start = 0; start < job.images.length; start += perRequest) {
      chunks.push({ ...job, images: job.images.slice(start, start + perRequest) });
    }
  }
  return chunks;
}

/** A run id for the inventory ledger's operation keys (one per import). */
export function newImportRunId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `run_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
