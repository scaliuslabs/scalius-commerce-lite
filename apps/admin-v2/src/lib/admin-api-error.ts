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

export interface ProductRevisionConflict {
  expectedRevision: number;
  currentRevision: number | null;
}

interface AdminApiErrorShape {
  status: number | null;
  code?: string;
  details?: unknown;
}

function readAdminApiError(
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

export function readProductRevisionConflict(
  error: unknown,
): ProductRevisionConflict | null {
  const parsed = readAdminApiError(error);
  if (
    parsed?.status !== 409 ||
    parsed.code !== "PRODUCT_REVISION_CONFLICT" ||
    !parsed.details ||
    typeof parsed.details !== "object"
  ) {
    return null;
  }

  const details = parsed.details as {
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
  if (
    typeof details.expectedRevision !== "number" ||
    !Number.isInteger(details.expectedRevision) ||
    details.expectedRevision < 1 ||
    !(
      details.currentRevision === null ||
      (typeof details.currentRevision === "number" &&
        Number.isInteger(details.currentRevision) &&
        details.currentRevision >= 1)
    )
  ) {
    return null;
  }

  return {
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
