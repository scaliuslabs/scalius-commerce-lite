/**
 * Status-preserving error returned by the admin API transport.
 *
 * Keep this module client-safe: TanStack Start serializes server-function
 * failures before a client-side route loader observes them.
 */
export class AdminApiResponseError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "AdminApiResponseError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** A settings save refused because the document changed since it was loaded. */
export interface SettingsRevisionConflict {
  /** The settings document key, e.g. "business". */
  document: string;
  expectedRevision: number;
  currentRevision: number | null;
}

interface AdminApiErrorShape {
  status: number | null;
  code?: string;
  details?: unknown;
}

export function readAdminApiError(
  value: unknown,
  seen = new Set<object>(),
): AdminApiErrorShape | null {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const candidate = value as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    code?: unknown;
    details?: unknown;
    cause?: unknown;
  };
  const nested = readAdminApiError(candidate.cause, seen);
  for (const status of [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
  ]) {
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      return {
        status,
        code:
          typeof candidate.code === "string" ? candidate.code : nested?.code,
        details: candidate.details ?? nested?.details,
      };
    }
  }

  if (typeof candidate.code === "string" || candidate.details !== undefined) {
    return {
      status: nested?.status ?? null,
      code:
        typeof candidate.code === "string" ? candidate.code : nested?.code,
      details: candidate.details ?? nested?.details,
    };
  }
  return nested;
}

export function isAdminApiNotFoundError(error: unknown): boolean {
  return readAdminApiError(error)?.status === 404;
}

/**
 * What a failed request says about its cause, so every screen words it the
 * same way and never blames the connection for an answer it did receive:
 * - `network`: no answer arrived (offline, timed out, aborted);
 * - `server`: the server answered with a fault (5xx);
 * - `notFound`: the server answered 404;
 * - `other`: any other refusal (validation, conflict, no access), which carries its own message.
 */
export type AdminErrorClass = "network" | "server" | "notFound" | "other";

const NETWORK_ERROR_NAMES = new Set(["TypeError", "AbortError", "TimeoutError"]);

export function classifyAdminError(error: unknown): AdminErrorClass {
  const status = readAdminApiError(error)?.status ?? null;
  if (status === null) return error instanceof Error && NETWORK_ERROR_NAMES.has(error.name) ? "network" : "other";
  return status >= 500 ? "server" : status === 404 ? "notFound" : "other";
}

/** The API's error code (e.g. BRAND_REVISION_CONFLICT), or null. */
export function readAdminApiErrorCode(error: unknown): string | null {
  return readAdminApiError(error)?.code ?? null;
}

export function isAdminApiConflictError(error: unknown): boolean {
  return readAdminApiError(error)?.status === 409;
}

export function readSettingsRevisionConflict(
  error: unknown,
): SettingsRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "SETTINGS_REVISION_CONFLICT" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }
  const details = parsed.details as {
    document?: unknown;
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
  const isRevision = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (
    typeof details.document !== "string" ||
    !isRevision(details.expectedRevision) ||
    !(details.currentRevision === null || isRevision(details.currentRevision))
  ) {
    return null;
  }
  return {
    document: details.document,
    expectedRevision: details.expectedRevision,
    currentRevision: details.currentRevision,
  };
}

/**
 * Converts only an authoritative API 404 to the detail-loader absence sentinel.
 * Every other failure must reach the route error boundary.
 */
export function nullForAdminApiNotFound(error: unknown): null {
  if (isAdminApiNotFoundError(error)) return null;
  throw error;
}
