export const ADMIN_API_READ_TIMEOUT_MS = 15_000;
export const ADMIN_API_READ_TIMEOUT_CODE = "ADMIN_API_READ_TIMEOUT";

export class AdminApiReadTimeoutError extends Error {
  readonly code = ADMIN_API_READ_TIMEOUT_CODE;
  readonly status = 504;

  constructor(timeoutMs = ADMIN_API_READ_TIMEOUT_MS) {
    super(
      `Admin API read timed out after ${Math.round(timeoutMs / 1000)}s. Please retry.`,
    );
    this.name = "AdminApiReadTimeoutError";
  }
}

export function isAdminApiReadTimeoutError(
  error: unknown,
): error is AdminApiReadTimeoutError {
  return error instanceof AdminApiReadTimeoutError;
}

export function shouldTimeoutAdminApiMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

export interface AdminApiReadTimeoutHandle {
  signal?: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
}

export function createAdminApiReadTimeout(
  method: string,
  parentSignal?: AbortSignal,
  timeoutMs = ADMIN_API_READ_TIMEOUT_MS,
): AdminApiReadTimeoutHandle {
  if (!shouldTimeoutAdminApiMethod(method)) {
    return {
      signal: undefined,
      didTimeout: () => false,
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  let timeoutReached = false;

  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  const timeoutId = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new AdminApiReadTimeoutError(timeoutMs));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function wrapResponseWithAdminApiReadTimeout(
  response: Response,
  timeout: AdminApiReadTimeoutHandle,
): Response {
  if (!timeout.signal || !response.body) {
    timeout.cleanup();
    return response;
  }

  const reader = response.body.getReader();
  let cleanedUp = false;
  const cleanupOnce = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    timeout.cleanup();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanupOnce();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        cleanupOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cleanupOnce();
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
