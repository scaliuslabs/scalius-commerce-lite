/**
 * The admin's single API transport: the generated `@scalius/api-client` SDK,
 * configured once here, plus `apiData()` which unwraps the `{ success, data }`
 * envelope and turns failures into `AdminApiResponseError`.
 *
 *   const category = await apiData(getApiV1AdminCategoriesById({ path: { id } }));
 *
 * Request path:
 * - Browser: same-origin `fetch` to `<dashboard base>/api/v1/admin/*` with the
 *   session cookie. Production answers through the admin proxy route
 *   (`routes/api/v1/admin/$.ts`, cross-origin cookie guard + read timeout);
 *   `vite dev` answers through the Vite proxy. Both return the API's raw
 *   envelope, which `apiData()` unwraps, so dev and production see one shape.
 * - Server (SSR loaders, server functions): `api.server.ts` forwards the
 *   incoming cookie/authorization to the API service binding and propagates
 *   Set-Cookie back.
 */
import { createIsomorphicFn } from "@tanstack/react-start";
import { client as apiClient } from "@scalius/api-client/client";

import { AdminApiResponseError } from "./admin-api-error";
import { withDashboardBasePath } from "./dashboard-base-path";
import { fetchAdminApiFromServer } from "./api.server";

const ADMIN_API_PREFIX = "/api/v1/admin/";

async function fetchAdminApiFromBrowser(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Only the admin proxy is reachable from the browser in production. Anything
  // else would work under `vite dev` (which proxies all of /api/v1) and then
  // fail in production, so reject it here in both.
  if (!url.pathname.startsWith(ADMIN_API_PREFIX)) {
    throw new Error(`Browser API calls must target ${ADMIN_API_PREFIX}*: ${url.pathname}`);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return fetch(withDashboardBasePath(url.pathname) + url.search, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.text() : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
}

const fetchAdminApi = createIsomorphicFn()
  .server((request: Request) => fetchAdminApiFromServer(request))
  .client((request: Request) => fetchAdminApiFromBrowser(request));

// The origin is a placeholder: both transports only use path + query.
apiClient.setConfig({
  baseUrl: "https://admin-api.invalid",
  // The API answers JSON envelopes; do not guess from Content-Type.
  parseAs: "json",
  // hey-api always calls `fetch(request)` with a built Request.
  fetch: ((request: Request) => fetchAdminApi(request)) as typeof fetch,
});

export { apiClient };

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown } | string;
}

function toAdminApiError(error: unknown, status: number): AdminApiResponseError {
  const body = (error && typeof error === "object" ? error : {}) as ApiErrorBody;
  const detail = body.error;
  if (typeof detail === "string") return new AdminApiResponseError(detail, status);
  return new AdminApiResponseError(
    detail?.message ?? `API error: ${status}`,
    status,
    detail?.code,
    detail?.details,
  );
}

/** The payload inside the API's `{ success, data }` envelope. */
export type ApiEnvelopeData<T> = T extends { data: infer D }
  ? D
  : T extends { success: unknown }
    ? Omit<T, "success">
    : T;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkFunction = (...args: any[]) => Promise<{ data?: unknown }>;

/** Unwrapped success payload of a generated SDK function. */
export type ApiResult<F extends SdkFunction> = ApiEnvelopeData<
  NonNullable<Awaited<ReturnType<F>>["data"]>
>;

/** Request body of a generated SDK function. */
export type ApiBody<F extends SdkFunction> = NonNullable<
  NonNullable<Parameters<F>[0]>["body"]
>;

/** Query parameters of a generated SDK function. */
export type ApiQuery<F extends SdkFunction> = NonNullable<
  NonNullable<Parameters<F>[0]>["query"]
>;

/**
 * Contract gap: `openapi-contract.ts` turns nullable timestamp unions into
 * `unknown`. The API sends `string | number | null` for these keys.
 */
export type WithTimestamps<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: string | number | null;
};

/**
 * Await a generated SDK call and return the envelope payload. Throws
 * `AdminApiResponseError` (status, code, details preserved) for API failures
 * and rethrows transport errors such as the read timeout unchanged.
 */
export async function apiData<T>(
  call: Promise<{ data?: T; error?: unknown; response?: Response }>,
): Promise<ApiEnvelopeData<NonNullable<T>>> {
  const { data, error, response } = await call;
  if (error !== undefined) {
    if (error instanceof Error) throw error;
    throw toAdminApiError(error, response?.status ?? 500);
  }
  if (response?.status === 204) return undefined as ApiEnvelopeData<NonNullable<T>>;
  const body = data as { success?: boolean; data?: unknown } | undefined;
  if (body?.success === false) throw toAdminApiError(body, response?.status ?? 500);
  if (body && typeof body === "object" && body.data !== undefined) {
    return body.data as ApiEnvelopeData<NonNullable<T>>;
  }
  const { success: _success, ...rest } = (body ?? {}) as Record<string, unknown>;
  return rest as ApiEnvelopeData<NonNullable<T>>;
}

