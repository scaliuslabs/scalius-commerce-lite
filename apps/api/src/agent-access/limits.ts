export const AGENT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const AGENT_MAX_RESULT_BYTES = 64 * 1024;
export const AGENT_MAX_BATCH_STEPS = 20;
export const AGENT_MAX_PARALLEL_READS = 2;
export const AGENT_DEFAULT_SEARCH_RESULTS = 20;
export const AGENT_MAX_SEARCH_RESULTS = 50;

export class AgentPayloadTooLargeError extends Error {
  constructor(readonly maxBytes = AGENT_MAX_REQUEST_BODY_BYTES) {
    super(
      maxBytes === AGENT_MAX_REQUEST_BODY_BYTES
        ? "Agent request body exceeds the 1 MiB limit"
        : `Agent request body exceeds the ${maxBytes} byte limit`,
    );
    this.name = "AgentPayloadTooLargeError";
  }
}

export class AgentRequestLengthMismatchError extends Error {
  constructor() {
    super("Agent request body does not match the declared Content-Length");
    this.name = "AgentRequestLengthMismatchError";
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function clampAgentResultBytes(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return AGENT_MAX_RESULT_BYTES;
  return Math.min(Math.floor(requested), AGENT_MAX_RESULT_BYTES);
}

export async function bufferBoundedAgentRequest(
  request: Request,
  maxBytes = AGENT_MAX_REQUEST_BODY_BYTES,
): Promise<Request> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    throw new AgentPayloadTooLargeError(maxBytes);
  }
  if (request.body === null) return request;

  const declaredLength = request.headers.get("Content-Length");
  let parsedDeclaredLength: number | null = null;
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new AgentRequestLengthMismatchError();
    }
    if (parsedLength > maxBytes) {
      throw new AgentPayloadTooLargeError(maxBytes);
    }
    parsedDeclaredLength = parsedLength;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AgentPayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (parsedDeclaredLength !== null && parsedDeclaredLength !== total) {
    throw new AgentRequestLengthMismatchError();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const headers = new Headers(request.headers);
  headers.set("Content-Length", String(total));
  return new Request(request, { body, headers });
}

export async function checkAgentRateLimit(
  env: Env,
  key: string,
): Promise<boolean> {
  const limiter = env.AGENT_RATE_LIMITER;
  if (!limiter) return false;
  const result = await limiter.limit({ key });
  return result.success;
}

export function getAgentClientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

export function agentNoStoreResponse(
  body: BodyInit | null,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Authorization, Origin");
  return new Response(body, { ...init, headers });
}

export function withAgentNoStoreHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Authorization, Origin");
  headers.delete("Cloudflare-CDN-Cache-Control");
  headers.delete("CDN-Cache-Control");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
