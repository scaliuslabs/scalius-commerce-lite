/**
 * SSR-side API fetching for Astro pages.
 *
 * All requests go through the admin proxy at /api/v1/admin/ which
 * transforms API responses from { success: true, data: T } to
 * { success: true, ...T }. These helpers strip the `success` flag
 * and return the remaining fields as T.
 */

const PROXY_BASE = "/api/v1/admin";

interface ProxyResponse {
  success: boolean;
  error?: string;
  errorCode?: string;
  [key: string]: unknown;
}

/**
 * Strip the `success` flag from a proxy response and return the rest as T.
 * Throws on non-OK status or success: false.
 */
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `API error: ${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as ProxyResponse;
      if (body.error) {
        message = String(body.error);
      }
    } catch {
      // Use default message if JSON parsing fails
    }
    throw new Error(message);
  }

  // 204 No Content — nothing to parse
  if (response.status === 204) {
    return undefined as T;
  }

  const body = (await response.json()) as ProxyResponse;

  if (body.success === false) {
    throw new Error(body.error ?? "Unknown API error");
  }

  // Strip `success` and return the rest as T
  const { success: _, ...data } = body;
  return data as T;
}

/**
 * Build a full URL from a path and optional query params.
 * The path should NOT include the /api/v1/admin prefix.
 */
function buildUrl(path: string, params?: Record<string, string>): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${PROXY_BASE}${normalizedPath}`;

  if (!params || Object.keys(params).length === 0) {
    return url;
  }

  const searchParams = new URLSearchParams(params);
  return `${url}?${searchParams.toString()}`;
}

/** GET request through the admin proxy. */
export async function apiGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = buildUrl(path, params);
  const response = await fetch(url);
  return handleResponse<T>(response);
}

/** POST request through the admin proxy. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const url = buildUrl(path);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(response);
}

/** PUT request through the admin proxy. */
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const url = buildUrl(path);
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(response);
}

/** DELETE request through the admin proxy. */
export async function apiDelete(path: string): Promise<void> {
  const url = buildUrl(path);
  const response = await fetch(url, { method: "DELETE" });
  await handleResponse<void>(response);
}
