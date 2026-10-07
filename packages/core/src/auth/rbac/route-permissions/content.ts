// Route permissions for the page, media and navigation API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

/** Viewing or editing any translatable resource; the handler checks the resource type's own permission. */
const TRANSLATION_VIEW = [
  PERMISSIONS.PRODUCTS_VIEW,
  PERMISSIONS.COLLECTIONS_VIEW,
  PERMISSIONS.CATEGORIES_VIEW,
  PERMISSIONS.PAGES_VIEW,
  PERMISSIONS.SETTINGS_HEADER_EDIT,
  PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW,
  PERMISSIONS.SETTINGS_GENERAL_VIEW,
];
const TRANSLATION_EDIT = [
  PERMISSIONS.PRODUCTS_EDIT,
  PERMISSIONS.COLLECTIONS_EDIT,
  PERMISSIONS.CATEGORIES_EDIT,
  PERMISSIONS.PAGES_EDIT,
  PERMISSIONS.SETTINGS_HEADER_EDIT,
  PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT,
  PERMISSIONS.SETTINGS_GENERAL_EDIT,
];

export const CONTENT_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Translations (MARKETS-DESIGN D9): each resource type's own permission,
  // checked again by the handler for the type it names.
  // =============================================
  "/api/v1/admin/translations/resources": {
    GET: { anyOf: TRANSLATION_VIEW },
  },
  "/api/v1/admin/translations/providers": {
    GET: { anyOf: TRANSLATION_EDIT },
  },
  "/api/v1/admin/translations/machine": {
    POST: { anyOf: TRANSLATION_EDIT },
  },
  "/api/v1/admin/translations/*/*": {
    GET: { anyOf: TRANSLATION_VIEW },
    PUT: { anyOf: TRANSLATION_EDIT },
    DELETE: { anyOf: TRANSLATION_EDIT },
  },
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
