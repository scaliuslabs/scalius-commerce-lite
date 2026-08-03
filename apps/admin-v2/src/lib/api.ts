import { createIsomorphicFn } from "@tanstack/react-start";

import { AdminApiResponseError } from "./admin-api-error";
import {
  apiDelete as serverApiDelete,
  apiGet as serverApiGet,
  apiPatch as serverApiPatch,
  apiPost as serverApiPost,
  apiPut as serverApiPut,
} from "./api.server";

type AdminApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface AdminApiRequest {
  method: AdminApiMethod;
  path: string;
  params?: Record<string, string>;
  body?: unknown;
}

interface ApiEnvelope {
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; details?: unknown } | string;
  [key: string]: unknown;
}

function buildBrowserAdminPath(
  path: string,
  params?: Record<string, string>,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const fullPath = `/api/v1/admin${normalizedPath}`;
  if (!params || Object.keys(params).length === 0) return fullPath;
  return `${fullPath}?${new URLSearchParams(params).toString()}`;
}

async function parseBrowserApiResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `API error: ${response.status} ${response.statusText}`;
    let code: string | undefined;
    let details: unknown;
    try {
      const body = (await response.json()) as ApiEnvelope;
      const error = body.error;
      if (typeof error === "string") {
        message = error;
      } else if (error && typeof error === "object") {
        message = error.message ?? message;
        code = error.code;
        details = error.details;
      }
    } catch {
      // Preserve the status-based fallback.
    }
    throw new AdminApiResponseError(
      message,
      response.status,
      code,
      details,
    );
  }

  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as ApiEnvelope;
  if (body.success === false) {
    const error = body.error;
    const message = typeof error === "string"
      ? error
      : error?.message ?? "Unknown API error";
    throw new AdminApiResponseError(message, response.status, error && typeof error === "object" ? error.code : undefined);
  }
  if (body.data !== undefined) return body.data as T;
  const { success: _success, ...rest } = body;
  return rest as T;
}

async function requestAdminApiFromBrowser(
  request: AdminApiRequest,
): Promise<unknown> {
  const hasBody = request.body !== undefined;
  const response = await fetch(
    buildBrowserAdminPath(request.path, request.params),
    {
      method: request.method,
      credentials: "same-origin",
      cache: "no-store",
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(request.body) : undefined,
    },
  );
  return parseBrowserApiResponse(response);
}

async function requestAdminApiFromServer(
  request: AdminApiRequest,
): Promise<unknown> {
  switch (request.method) {
    case "GET":
      return serverApiGet(request.path, request.params);
    case "POST":
      return serverApiPost(request.path, request.body);
    case "PUT":
      return serverApiPut(request.path, request.body);
    case "PATCH":
      return serverApiPatch(request.path, request.body);
    case "DELETE":
      return serverApiDelete(request.path, request.body);
  }
}

const requestAdminApi = createIsomorphicFn()
  .server(requestAdminApiFromServer)
  .client(requestAdminApiFromBrowser);

export function apiGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  return requestAdminApi({ method: "GET", path, params }) as Promise<T>;
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return requestAdminApi({ method: "POST", path, body }) as Promise<T>;
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return requestAdminApi({ method: "PUT", path, body }) as Promise<T>;
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return requestAdminApi({ method: "PATCH", path, body }) as Promise<T>;
}

export function apiDelete<T = void>(path: string, body?: unknown): Promise<T> {
  return requestAdminApi({ method: "DELETE", path, body }) as Promise<T>;
}
