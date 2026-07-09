import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  adminApiHeaders,
  failClosedStatus,
  isRecord,
  parseJsonResponse,
  toolResult,
} from "./shared";
import type {
  AdminMcpAuthContext,
  AdminPermissionsFailure,
  AdminPermissionsResult,
  Env,
  JsonRecord,
} from "./types";

export const ADMIN_PERMISSIONS_PATH = "/api/v1/admin/rbac/my-permissions";

const ADMIN_API_TARGET = `http://api.internal${ADMIN_PERMISSIONS_PATH}`;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

export interface AdminPermissionContext {
  userId?: string;
  isSuperAdmin: boolean;
  roles: JsonRecord[];
  permissions: string[];
  overrides: {
    grants: string[];
    denials: string[];
  };
}
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function getCookieHeader(headers: Headers): string | null {
  const cookie = headers.get("Cookie");
  return cookie?.trim() ? cookie : null;
}

function failureCodeForStatus(status: number): string {
  if (status === 401) return "admin_session_invalid";
  if (status === 403) return "admin_session_forbidden";
  if (status >= 400 && status < 500) return "admin_session_denied";
  return "admin_session_unavailable";
}

function adminAuthFailureResponse(failure: AdminPermissionsFailure): Response {
  const status = failClosedStatus(failure.status);
  return jsonResponse({
    success: false,
    error: {
      code: failure.code,
      message: status === 503
        ? "Admin session verification is temporarily unavailable."
        : "Admin session is not authorized for MCP.",
    },
  }, status);
}

export async function fetchAdminPermissions(
  env: Env,
  {
    cookie,
    userAgent,
    signal,
  }: {
    cookie: string;
    userAgent?: string | null;
    signal?: AbortSignal;
  },
): Promise<AdminPermissionsResult> {
  if (!env.API || typeof env.API.fetch !== "function") {
    return { ok: false, status: 503, code: "admin_api_unavailable" };
  }

  try {
    const response = await env.API.fetch(ADMIN_API_TARGET, {
      method: "GET",
      headers: adminApiHeaders(cookie, userAgent),
      signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: failureCodeForStatus(response.status),
      };
    }

    const body = await parseJsonResponse(response);
    if (!body || body.success === false) {
      return { ok: false, status: 503, code: "admin_permissions_invalid" };
    }

    return { ok: true, body };
  } catch {
    return { ok: false, status: 503, code: "admin_session_unavailable" };
  }
}

export async function resolveAdminMcpRequestAuth(
  request: Request,
  env: Env,
): Promise<AdminMcpAuthContext | Response> {
  const cookie = getCookieHeader(request.headers);
  if (!cookie) {
    return jsonResponse({
      success: false,
      error: {
        code: "admin_session_required",
        message: "Admin MCP requires an active dashboard session.",
      },
    }, 401);
  }

  const userAgent = request.headers.get("User-Agent");
  const result = await fetchAdminPermissions(env, {
    cookie,
    userAgent,
    signal: request.signal,
  });
  if (!result.ok) return adminAuthFailureResponse(result);

  return {
    cookie,
    userAgent,
    permissionsBody: result.body,
  };
}

export async function guardAdminMcpRequest(request: Request, env: Env): Promise<Response | null> {
  const auth = await resolveAdminMcpRequestAuth(request, env);
  return auth instanceof Response ? auth : null;
}

export function adminToolError(failure: AdminPermissionsFailure): CallToolResult {
  return toolResult({
    error: {
      code: failure.code,
      status: failClosedStatus(failure.status),
      message: failure.status >= 500
        ? "Admin session context is temporarily unavailable."
        : "Admin session is not authorized for MCP.",
    },
  }, true);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function compactRoles(value: unknown): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;

  return value.flatMap((role) => {
    if (!isRecord(role)) return [];
    const compact: JsonRecord = {};
    if (typeof role.id === "string") compact.id = role.id;
    if (typeof role.name === "string") compact.name = role.name;
    return Object.keys(compact).length > 0 ? [compact] : [];
  });
}

function compactKnownPermissionContext(value: JsonRecord): JsonRecord | null {
  const context: JsonRecord = {};
  if (typeof value.userId === "string") context.userId = value.userId;
  if (typeof value.isSuperAdmin === "boolean") context.isSuperAdmin = value.isSuperAdmin;

  const roles = compactRoles(value.roles);
  if (roles) context.roles = roles;

  const permissions = stringArray(value.permissions);
  if (permissions) context.permissions = permissions;

  if (isRecord(value.overrides)) {
    const overrides: JsonRecord = {};
    const grants = stringArray(value.overrides.grants);
    const denials = stringArray(value.overrides.denials);
    if (grants) overrides.grants = grants;
    if (denials) overrides.denials = denials;
    if (Object.keys(overrides).length > 0) context.overrides = overrides;
  }

  return Object.keys(context).length > 0 ? context : null;
}

export function parseAdminPermissionContext(body: JsonRecord): AdminPermissionContext {
  const payload = isRecord(body.data) ? body.data : body;
  const roles = compactRoles(payload.roles) ?? [];
  const permissions = stringArray(payload.permissions) ?? [];
  const grants = isRecord(payload.overrides)
    ? stringArray(payload.overrides.grants) ?? []
    : [];
  const denials = isRecord(payload.overrides)
    ? stringArray(payload.overrides.denials) ?? []
    : [];

  return {
    ...(typeof payload.userId === "string" ? { userId: payload.userId } : {}),
    isSuperAdmin: payload.isSuperAdmin === true,
    roles,
    permissions,
    overrides: { grants, denials },
  };
}

export function buildAdminSessionContext(body: JsonRecord): JsonRecord {
  const payload = isRecord(body.data) ? body.data : body;
  const knownContext = compactKnownPermissionContext(payload);

  return {
    adminSessionContext: knownContext ?? {
      permissionsResponse: payload,
    },
  };
}
