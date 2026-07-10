import type {
  AdminFlueComputerAuthorityResolution,
  ResolveAdminFlueComputerAuthority,
} from "./-result-proxy";

const ADMIN_FLUE_ADMISSION_URL =
  "http://api.internal/api/v1/internal/admin-assistant/flue/admit";
const MAX_ADMISSION_RESPONSE_BYTES = 4_096;
const MAX_COOKIE_BYTES = 8_192;
const ADMISSION_TIMEOUT_MS = 5_000;
const THREAD_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22,64}$/u;
const INSTANCE_ID_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;
const TENANT_ID_PATTERN = /^tenant_[A-Za-z0-9_-]{43}$/u;
const PRINCIPAL_ID_PATTERN = /^principal_[A-Za-z0-9_-]{43}$/u;

export interface AdminFlueAuthorityDependencies {
  api?: Pick<Fetcher, "fetch">;
  now?: () => number;
  timeoutSignal?: () => AbortSignal;
}

/**
 * Resolve the browser's requested thread through the API-owned dashboard
 * session and D1 authority. Only the dashboard cookie crosses this service
 * boundary; browser identity/service headers are never forwarded.
 */
export function createAdminFlueAuthorityResolver(
  dependencies: AdminFlueAuthorityDependencies,
): ResolveAdminFlueComputerAuthority {
  return async ({ request, requestedThreadId }) => {
    if (!dependencies.api || !THREAD_ID_PATTERN.test(requestedThreadId)) {
      return { ok: false, reason: "unavailable" };
    }
    const cookie = request.headers.get("cookie")?.trim() ?? "";
    if (
      !cookie ||
      new TextEncoder().encode(cookie).byteLength > MAX_COOKIE_BYTES
    ) {
      return { ok: false, reason: "unauthenticated" };
    }

    let response: Response;
    try {
      response = await dependencies.api.fetch(ADMIN_FLUE_ADMISSION_URL, {
        method: "POST",
        redirect: "manual",
        signal: dependencies.timeoutSignal?.() ??
          AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ threadId: requestedThreadId }),
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }

    if (response.status === 401) {
      await response.body?.cancel();
      return { ok: false, reason: "unauthenticated" };
    }
    if (response.status === 403) {
      await response.body?.cancel();
      return { ok: false, reason: "forbidden" };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ok: false, reason: "unavailable" };
    }

    const value = await readBoundedJson(response, MAX_ADMISSION_RESPONSE_BYTES);
    const authority = parseAdmissionEnvelope(
      value,
      requestedThreadId,
      dependencies.now?.() ?? Date.now(),
    );
    return authority
      ? { ok: true, authority }
      : { ok: false, reason: "unavailable" };
  };
}

function parseAdmissionEnvelope(
  value: unknown,
  requestedThreadId: string,
  now: number,
): Extract<AdminFlueComputerAuthorityResolution, { ok: true }>["authority"] | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["success", "data"]) || value.success !== true) {
    return null;
  }
  if (!isRecord(value.data) || !hasOnlyKeys(value.data, ["agent"]) || !isRecord(value.data.agent)) {
    return null;
  }
  const agent = value.data.agent;
  if (!hasOnlyKeys(agent, [
    "surface",
    "instanceId",
    "tenantId",
    "principalId",
    "threadId",
    "expiresAt",
  ])) return null;
  if (
    agent.surface !== "admin" ||
    typeof agent.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(agent.instanceId) ||
    typeof agent.tenantId !== "string" || !TENANT_ID_PATTERN.test(agent.tenantId) ||
    typeof agent.principalId !== "string" || !PRINCIPAL_ID_PATTERN.test(agent.principalId) ||
    agent.threadId !== requestedThreadId || !THREAD_ID_PATTERN.test(agent.threadId) ||
    typeof agent.expiresAt !== "number" || !Number.isSafeInteger(agent.expiresAt) ||
    agent.expiresAt <= now
  ) return null;

  return {
    surface: "admin",
    instanceId: agent.instanceId,
    tenantId: agent.tenantId,
    principalId: agent.principalId,
    threadId: agent.threadId,
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const expected = new Set(required);
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
