/**
 * Transport for an installed app's own dashboard routes
 * (`/api/v1/plugins/<id>/admin/<route>[/<subpath>]`, apps/api/src/plugins/routes.ts).
 * They are not in the generated SDK, and they answer differently from it:
 *
 *   success → the app's RAW JSON body (no `{ success, data }` envelope), with
 *             the status the app chose (an action may answer 422 with a toast);
 *   failure → the platform's `{ success: false, error: { code, message } }`
 *             (inactive app, undeclared route, timeout, crash), 4xx/5xx.
 *
 * Both shapes are handled here explicitly so callers never guess. A platform
 * failure throws `AdminApiResponseError` (status, code and the app's masked
 * reason preserved); anything else returns `{ status, ok, body }`.
 */
import { AdminApiResponseError } from "./admin-api-error";
import { adminApiReadSignal } from "./admin-api-timeout";
import { noticeAdminUnauthorized } from "./admin-session-lost";
import { withDashboardBasePath } from "./dashboard-base-path";
import { getLocale } from "~/i18n";

export type AppRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AppRouteRequest {
  method?: AppRouteMethod;
  /** Plain path segments after the route name (`a/b`). */
  subpath?: string;
  query?: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  body?: unknown;
  signal?: AbortSignal;
}

export interface AppRouteResponse {
  status: number;
  ok: boolean;
  /** The app's JSON (null for an empty answer). */
  body: unknown;
}

/** Error codes this transport raises itself (the API's own codes pass through). */
export const APP_ROUTE_BAD_ANSWER = "APP_BAD_ANSWER";

export function appRoutePath(pluginId: string, route: string, subpath?: string): string {
  const rest = subpath ? `/${subpath.split("/").map(encodeURIComponent).join("/")}` : "";
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/admin/${encodeURIComponent(route)}${rest}`;
}

/** The platform's failure envelope, exactly; an app's own body never matches by accident. */
function platformFailure(body: unknown): { code: string; message: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const candidate = body as { success?: unknown; error?: unknown };
  if (candidate.success !== false || !candidate.error || typeof candidate.error !== "object") return null;
  const error = candidate.error as { code?: unknown; message?: unknown };
  if (typeof error.code !== "string") return null;
  return { code: error.code, message: typeof error.message === "string" ? error.message : "" };
}

export async function fetchAppRoute(pluginId: string, route: string, request: AppRouteRequest = {}): Promise<AppRouteResponse> {
  const method = request.method ?? "GET";
  const search = new URLSearchParams(request.query ?? {}).toString();
  // The dashboard's language: an app writes its screen in it (`adminContext().locale`).
  const headers: Record<string, string> = { Accept: "application/json", "Accept-Language": getLocale() };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(withDashboardBasePath(appRoutePath(pluginId, route, request.subpath)) + (search ? `?${search}` : ""), {
    method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    credentials: "same-origin",
    cache: "no-store",
    signal: adminApiReadSignal(method, request.signal),
  });
  // Signed out while the page was open: the shell decides whether to leave.
  if (response.status === 401) void noticeAdminUnauthorized();

  const text = await response.text();
  let body: unknown = null;
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new AdminApiResponseError("", response.status >= 400 ? response.status : 502, APP_ROUTE_BAD_ANSWER);
    }
  }
  const failure = response.ok ? null : platformFailure(body);
  if (failure) throw new AdminApiResponseError(failure.message, response.status, failure.code);
  return { status: response.status, ok: response.ok, body };
}

/** A GET of a page, card or widget: only a 2xx answer is a document. */
export async function fetchAppDocument(pluginId: string, route: string, request: Omit<AppRouteRequest, "method" | "body"> = {}): Promise<unknown> {
  const response = await fetchAppRoute(pluginId, route, { ...request, method: "GET" });
  if (!response.ok) throw new AdminApiResponseError("", response.status, APP_ROUTE_BAD_ANSWER);
  return response.body;
}

/** A file the dashboard stored for one of an app's admin forms (`file-field`). */
export interface AppUpload {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
}

/**
 * Sends a file staff chose in an app's form to the platform
 * (`POST /api/v1/admin/apps/<id>/uploads`, apps/api/src/routes/admin/apps-uploads.ts),
 * which types it from its bytes and keeps it privately for the app; the
 * form then sends the returned id as the field's value. `route` is the admin
 * route the form posts to. A refusal throws `AdminApiResponseError` with the
 * platform's code (`upload_type_not_accepted`, `upload_too_large`).
 */
export async function uploadAppFile(pluginId: string, route: string, file: File, signal?: AbortSignal): Promise<AppUpload> {
  const form = new FormData();
  form.set("file", file);
  form.set("route", route);
  const response = await fetch(withDashboardBasePath(`/api/v1/admin/apps/${encodeURIComponent(pluginId)}/uploads`), {
    method: "POST",
    body: form,
    headers: { Accept: "application/json", "Accept-Language": getLocale() },
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (response.status === 401) void noticeAdminUnauthorized();
  const body = (await response.json().catch(() => null)) as { success?: boolean; data?: { upload?: AppUpload }; error?: { code?: string; message?: string; details?: unknown } } | null;
  const upload = response.ok ? body?.data?.upload : undefined;
  if (!upload) throw new AdminApiResponseError(body?.error?.message ?? "", response.status, body?.error?.code ?? APP_ROUTE_BAD_ANSWER, body?.error?.details);
  return upload;
}
