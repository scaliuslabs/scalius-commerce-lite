// Route permissions for the page, media and navigation API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const CONTENT_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Pages API
  // =============================================
  "/api/v1/admin/pages": {
    GET: { permission: PERMISSIONS.PAGES_VIEW },
    POST: { permission: PERMISSIONS.PAGES_CREATE },
  },
  "/api/v1/admin/pages/bulk-delete": {
    POST: { permission: PERMISSIONS.PAGES_DELETE },
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },
  "/api/v1/admin/pages/bulk-restore": {
    POST: { permission: PERMISSIONS.PAGES_EDIT },
  },
  "/api/v1/admin/pages/bulk-publish": {
    POST: { permission: PERMISSIONS.PAGES_PUBLISH },
  },
  "/api/v1/admin/pages/bulk-unpublish": {
    POST: { permission: PERMISSIONS.PAGES_PUBLISH },
  },
  "/api/v1/admin/pages/*": {
    GET: { permission: PERMISSIONS.PAGES_VIEW },
    PUT: { permission: PERMISSIONS.PAGES_EDIT },
    PATCH: { permission: PERMISSIONS.PAGES_EDIT },
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },
  "/api/v1/admin/pages/*/restore": {
    POST: { permission: PERMISSIONS.PAGES_EDIT },
  },
  "/api/v1/admin/pages/*/permanent": {
    DELETE: { permission: PERMISSIONS.PAGES_DELETE },
  },
  // =============================================
  // Media API
  // =============================================
  "/api/v1/admin/media": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/uploads": {
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/uploads/import-url": {
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/uploads/reconcile": {
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/uploads/*": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    DELETE: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/uploads/*/parts/*": {
    PUT: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/uploads/*/complete": {
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/move": {
    POST: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
  },
  "/api/v1/admin/media/*": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    PUT: { permission: PERMISSIONS.MEDIA_UPLOAD },
    PATCH: { permission: PERMISSIONS.MEDIA_UPLOAD },
    DELETE: { permission: PERMISSIONS.MEDIA_DELETE },
  },
  "/api/v1/admin/media/*/trash": {
    POST: { permission: PERMISSIONS.MEDIA_DELETE },
  },
  "/api/v1/admin/media/*/restore": {
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/*/permanent": {
    DELETE: { permission: PERMISSIONS.MEDIA_DELETE },
  },
  "/api/v1/admin/media/*/variants": {
    POST: { permission: PERMISSIONS.MEDIA_UPLOAD },
  },
  "/api/v1/admin/media/*/original": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
  },
  "/api/v1/admin/media/*/usage": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
  },
  "/api/v1/admin/media/folders": {
    GET: { permission: PERMISSIONS.MEDIA_VIEW },
    POST: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
  },
  "/api/v1/admin/media/folders/*": {
    PUT: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
    DELETE: { permission: PERMISSIONS.MEDIA_MANAGE_FOLDERS },
  },
  // =============================================
  // Navigation API
  // =============================================
  "/api/v1/admin/navigation": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/navigation/*": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PATCH: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/navigation/*/*": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PATCH: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/navigation/*/*/*": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PATCH: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/navigation/*/*/*/*": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PATCH: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/navigation/*/*/*/*/*": {
    GET: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    POST: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PATCH: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    PUT: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_HEADER_EDIT },
  },
  "/api/v1/admin/navigation/preview-products": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
};
