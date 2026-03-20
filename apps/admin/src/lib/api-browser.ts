/**
 * Client-side API fetching utility for React components.
 *
 * All responses use the standard API envelope: { success, data: T }.
 * Both the admin proxy and Vite dev proxy pass through unchanged.
 * This utility unwraps the envelope and returns T directly.
 */

const PROXY_BASE = "/api/v1/admin";

/**
 * Parse API response envelope { success, data: T }.
 * Returns the unwrapped data payload T.
 */
async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `API error: ${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) {
        const err = body.error;
        message = typeof err === "string"
          ? err
          : err?.message ?? message;
      }
    } catch {
      // Use default message
    }
    throw new Error(message);
  }

  if (response.status === 204) return undefined as T;

  const body = await response.json();

  if (body?.success === false) {
    const err = body.error;
    throw new Error(
      typeof err === "string" ? err : err?.message ?? "Unknown API error",
    );
  }

  // Standard envelope: { success, data: T } — return data
  if (body.data !== undefined) {
    return body.data as T;
  }

  // Fallback for non-envelope responses
  const { success: _, ...rest } = body;
  return rest as T;
}

/**
 * Build full proxy URL from path + optional params.
 * Path should NOT include /api/v1/admin prefix.
 */
function buildUrl(path: string, params?: Record<string, string>): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${PROXY_BASE}${normalizedPath}`;
  if (!params || Object.keys(params).length === 0) return url;
  const sp = new URLSearchParams(params);
  return `${url}?${sp.toString()}`;
}

/** Client-side GET request through admin proxy. Returns unwrapped T. */
export async function clientGet<T>(
  path: string,
  params?: Record<string, string>,
  fetchOptions?: RequestInit,
): Promise<T> {
  const url = buildUrl(path, params);
  const response = await fetch(url, { ...fetchOptions });
  return parseResponse<T>(response);
}

/** Client-side POST request through admin proxy. Returns unwrapped T. */
export async function clientPost<T>(
  path: string,
  body: unknown,
  fetchOptions?: RequestInit,
): Promise<T> {
  const url = buildUrl(path);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...fetchOptions,
    body: JSON.stringify(body),
  });
  return parseResponse<T>(response);
}

/** Client-side PUT request through admin proxy. Returns unwrapped T. */
export async function clientPut<T>(
  path: string,
  body: unknown,
  fetchOptions?: RequestInit,
): Promise<T> {
  const url = buildUrl(path);
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    ...fetchOptions,
    body: JSON.stringify(body),
  });
  return parseResponse<T>(response);
}

/** Client-side DELETE request through admin proxy. */
export async function clientDelete(
  path: string,
  fetchOptions?: RequestInit,
): Promise<void> {
  const url = buildUrl(path);
  const response = await fetch(url, {
    method: "DELETE",
    ...fetchOptions,
  });
  await parseResponse<void>(response);
}

/**
 * Parse a raw fetch response (for components that build their own URLs).
 * Same envelope unwrapping logic, but doesn't build the URL.
 */
export { parseResponse as unwrapApiResponse };
