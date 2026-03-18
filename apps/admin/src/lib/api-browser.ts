/**
 * Client-side API fetching utility for React components.
 *
 * In production, requests go through the admin proxy (pages/api/v1/[...path].ts)
 * which unwraps { success, data: T } → { success, ...T }.
 *
 * In dev, Vite's proxy (astro.config.mjs) intercepts /api/v1/* and forwards
 * directly to the API worker, BYPASSING the admin proxy. So responses arrive
 * as raw { success, data: T }.
 *
 * This utility normalizes both shapes to return T directly.
 */

const PROXY_BASE = "/api/v1/admin";

/**
 * Parse API response, handling both envelope shapes.
 * Returns the unwrapped data payload T.
 */
async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `API error: ${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) {
        message = typeof body.error === "string"
          ? body.error
          : body.error?.message ?? message;
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

  // Raw API envelope: { success, data: T } — unwrap data
  if (
    body.data !== undefined &&
    Object.keys(body).filter((k) => k !== "success").length === 1
  ) {
    return body.data as T;
  }

  // Proxy-unwrapped: { success, ...T } — strip success
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
