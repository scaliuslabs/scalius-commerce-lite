/** One checkout decision must not spend more than two seconds waiting for providers. */
export const PROVIDER_CHECKOUT_DEADLINE_MS = 2_000;

export async function withCheckoutProviderDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Checkout provider deadline exceeded."));
        }, PROVIDER_CHECKOUT_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}
