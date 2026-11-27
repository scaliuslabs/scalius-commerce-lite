// Work a test hands to an execution context's `waitUntil` (the after-response work of a request, a run's
// bookkeeping): one registry per test file, shared by every test context (`testExecutionContext`), so the setup
// file (scripts/vitest-setup.mjs) fails a file whose background work is still pending, or rejected, when it ends.
// A test settles it before its database closes (`settleTestBackground`).

const REGISTRY = Symbol.for("scalius.test.background");

/** The file's registry: each tracked promise with its state. */
export function backgroundRegistry() {
  let registry = globalThis[REGISTRY];
  if (!registry) {
    registry = { work: [] };
    globalThis[REGISTRY] = registry;
  }
  return registry;
}

/** Tracks one promise handed to `waitUntil`. */
export function trackBackground(promise) {
  const entry = { state: "pending", error: undefined, promise: Promise.resolve(promise) };
  entry.promise.then(() => { entry.state = "done"; }, (error) => { entry.state = "rejected"; entry.error = error; });
  backgroundRegistry().work.push(entry);
}

/** An execution context whose `waitUntil` work is tracked (and settled by `settleTestBackground`). */
export function testExecutionContext(extra = {}) {
  return { waitUntil: (promise) => trackBackground(promise), passThroughOnException: () => undefined, props: {}, exports: {}, ...extra };
}

/** Awaits every tracked task, including tasks those tasks start; throws the first that rejected. */
export async function settleTestBackground() {
  const registry = backgroundRegistry();
  let failure = null;
  while (registry.work.length > 0) {
    const batch = registry.work.splice(0);
    const results = await Promise.allSettled(batch.map((entry) => entry.promise));
    for (const result of results) if (result.status === "rejected" && !failure) failure = result.reason;
  }
  if (failure) throw failure;
}

/** At a file's end: what is still pending or rejected (and forgets it, so the next file starts clean). */
export function unsettledBackground() {
  const registry = backgroundRegistry();
  const pending = registry.work.filter((entry) => entry.state === "pending").length;
  const rejected = registry.work.filter((entry) => entry.state === "rejected");
  registry.work = [];
  return { pending, rejected };
}
