// Route permissions for the conversation API (the dashboard inbox and order threads).
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const CONVERSATION_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/conversations": {
    GET: { permission: PERMISSIONS.CONVERSATIONS_VIEW },
  },
  "/api/v1/admin/conversations/summary": {
    GET: { permission: PERMISSIONS.CONVERSATIONS_VIEW },
  },
  "/api/v1/admin/conversations/attachments": {
    POST: { permission: PERMISSIONS.CONVERSATIONS_REPLY },
  },
  "/api/v1/admin/conversations/order/*": {
    GET: { permission: PERMISSIONS.CONVERSATIONS_VIEW },
  },
  "/api/v1/admin/conversations/order/*/messages": {
    POST: { permission: PERMISSIONS.CONVERSATIONS_REPLY },
  },
  "/api/v1/admin/conversations/*": {
    GET: { permission: PERMISSIONS.CONVERSATIONS_VIEW },
    PATCH: { permission: PERMISSIONS.CONVERSATIONS_REPLY },
  },
  "/api/v1/admin/conversations/*/messages": {
    POST: { permission: PERMISSIONS.CONVERSATIONS_REPLY },
  },
  "/api/v1/admin/conversations/*/read": {
    POST: { permission: PERMISSIONS.CONVERSATIONS_VIEW },
  },
  "/api/v1/admin/conversations/*/attachments/*": {
    GET: { permission: PERMISSIONS.CONVERSATIONS_VIEW },
  },
};
