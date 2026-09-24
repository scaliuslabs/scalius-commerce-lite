// Route permissions for the agent access API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const AGENT_ACCESS_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Agent Access API
  // =============================================
  "/api/v1/admin/agent-access/connections": {
    GET: { permission: PERMISSIONS.AGENT_ACCESS_VIEW },
  },
  "/api/v1/admin/agent-access/connections/revoked": {
    DELETE: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
  "/api/v1/admin/agent-access/connections/*": {
    GET: { permission: PERMISSIONS.AGENT_ACCESS_VIEW },
  },
  "/api/v1/admin/agent-access/connections/*/events": {
    GET: { permission: PERMISSIONS.AGENT_ACCESS_VIEW },
  },
  "/api/v1/admin/agent-access/tokens": {
    POST: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
  "/api/v1/admin/agent-access/tokens/*/rotate": {
    POST: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
  "/api/v1/admin/agent-access/grants/*": {
    PATCH: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
    DELETE: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
  "/api/v1/admin/agent-access/revoke-all": {
    POST: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
  "/api/v1/admin/agent-access/authorization-requests/*": {
    GET: { permission: PERMISSIONS.AGENT_ACCESS_VIEW },
  },
  "/api/v1/admin/agent-access/authorization-requests/*/approve": {
    POST: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
  "/api/v1/admin/agent-access/authorization-requests/*/deny": {
    POST: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
  "/api/v1/admin/agent-access/device-authorizations/lookup": {
    POST: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
  "/api/v1/admin/agent-access/device-authorizations/*/approve": {
    POST: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
  "/api/v1/admin/agent-access/device-authorizations/*/deny": {
    POST: { permission: PERMISSIONS.AGENT_ACCESS_MANAGE },
  },
};
