import { describe, expect, it, vi } from "vitest";
import { chunkImageJobs, ImportRunError, runInBatches, runPool } from "./import-runner";

const echo = (processedLimit = Infinity) => vi.fn(async (batch: number[]) => {
  const processed = Math.min(batch.length, processedLimit);
  return { results: batch.slice(0, processed).map((value) => value * 10), processed, stoppedEarly: processed < batch.length };
});

describe("import runner", () => {
  it("sends bounded batches and keeps results in item order", async () => {
    const send = echo();
    const progress: number[] = [];
    const { results, completed } = await runInBatches([1, 2, 3, 4, 5], { send, size: 2, onProgress: ({ done }) => progress.push(done) });
    expect(completed).toBe(true);
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(send.mock.calls.map(([batch]) => batch)).toEqual([[1, 2], [3, 4], [5]]);
    expect(progress).toEqual([2, 4, 5]);
  });

  it("sends again what the server did not process and shrinks the batch", async () => {
    // A Workers Free account: the server manages two items per request.
    const send = echo(2);
    const { results } = await runInBatches([1, 2, 3, 4, 5, 6, 7], { send, size: 5 });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(send.mock.calls.map(([batch]) => batch)).toEqual([[1, 2, 3, 4, 5], [3, 4], [5, 6], [7]]);
  });

  it("keeps a batch under the byte ceiling", async () => {
    const send = echo();
    const big = "x".repeat(400);
    await runInBatches([big, big, big, big].map((text, index) => `${index}${text}`), { send: send as never, size: 10, maxBytes: 1000 });
    expect(send.mock.calls.map(([batch]) => batch.length)).toEqual([2, 2]);
  });

  it("retries network and server errors, but not a refused request", async () => {
    let calls = 0;
    const flaky = vi.fn(async (batch: number[]) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("Bad gateway"), { status: 502 });
      return { results: batch, processed: batch.length, stoppedEarly: false };
    });
    expect((await runInBatches([1, 2], { send: flaky, size: 2, backoff: () => 0 })).results).toEqual([1, 2]);
    expect(flaky).toHaveBeenCalledTimes(2);

    const refused = vi.fn(async () => {
      throw Object.assign(new Error("This import needs the products.edit permission."), { status: 403 });
    });
    await expect(runInBatches([1], { send: refused, size: 1, backoff: () => 0 })).rejects.toMatchObject({ name: "ImportRunError", status: 403 });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("gives up when the server makes no progress", async () => {
    const stuck = vi.fn(async () => ({ results: [], processed: 0, stoppedEarly: true }));
    await expect(runInBatches([1, 2], { send: stuck, size: 2, retries: 2, backoff: () => 0 })).rejects.toBeInstanceOf(ImportRunError);
  });

  it("stops between batches when aborted", async () => {
    const controller = new AbortController();
    const send = vi.fn(async (batch: number[]) => {
      controller.abort();
      return { results: batch, processed: batch.length, stoppedEarly: false };
    });
    const outcome = await runInBatches([1, 2, 3, 4], { send, size: 2, signal: controller.signal });
    expect(outcome).toEqual({ results: [1, 2], completed: false });
  });

  it("splits image jobs and runs them a few at a time in order", async () => {
    const chunks = chunkImageJobs([{ productId: "p1", images: [1, 2, 3, 4, 5] }, { productId: "p2", images: [6] }], 2);
    expect(chunks.map((job) => [job.productId, job.images])).toEqual([["p1", [1, 2]], ["p1", [3, 4]], ["p1", [5]], ["p2", [6]]]);
    let inFlight = 0;
    let peak = 0;
    const results = await runPool(chunks, 2, async (job) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return job.images.length;
    });
    expect(results).toEqual([2, 2, 1, 1]);
    expect(peak).toBe(2);
  });
});
