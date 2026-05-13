const WIDGET_GENERATION_TIMEOUT_MS = 95_000;

function createTimeoutError(): DOMException {
  return new DOMException('Widget generation timed out. Please try again with a smaller context or a faster model.', 'TimeoutError');
}

export async function fetchWidgetAi(
  input: RequestInfo | URL,
  init: RequestInit & { signal?: AbortSignal } = {},
  timeoutMs = WIDGET_GENERATION_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) {
    abortFromParent();
  } else {
    init.signal?.addEventListener('abort', abortFromParent, { once: true });
  }

  timeoutId = setTimeout(() => {
    controller.abort(createTimeoutError());
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    init.signal?.removeEventListener('abort', abortFromParent);
  }
}

