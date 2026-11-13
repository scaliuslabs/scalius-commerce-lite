// Who may read and translate each kind of resource in Translate & adapt
// (docs/MARKETS-DESIGN.md D9): the resource's own view and edit permissions.
// One table: the API checks it per request (apps/api/src/routes/admin/
// translations.ts), the route map opens the page's reads to any of the views
// (route-permissions/shared.ts TRANSLATION_VIEW), and the dashboard shows a
// kind's tab only to a role that may read it.
import { PERMISSIONS } from "./permissions";
import type { PermissionName } from "./types";

/** The kinds of resource Translate & adapt lists, in the order its tabs show them. */
export const TRANSLATION_RESOURCE_TYPES = [
  "product", "collection", "category", "brand", "page", "menu", "shipping_method", "payment_method",
] as const;
export type TranslationResourceType = (typeof TRANSLATION_RESOURCE_TYPES)[number];

export const TRANSLATION_TYPE_PERMISSIONS: Readonly<Record<TranslationResourceType, { view: PermissionName; edit: PermissionName }>> = {
  product: { view: PERMISSIONS.PRODUCTS_VIEW, edit: PERMISSIONS.PRODUCTS_EDIT },
  collection: { view: PERMISSIONS.COLLECTIONS_VIEW, edit: PERMISSIONS.COLLECTIONS_EDIT },
  category: { view: PERMISSIONS.CATEGORIES_VIEW, edit: PERMISSIONS.CATEGORIES_EDIT },
  brand: { view: PERMISSIONS.CATEGORIES_VIEW, edit: PERMISSIONS.CATEGORIES_EDIT },
  page: { view: PERMISSIONS.PAGES_VIEW, edit: PERMISSIONS.PAGES_EDIT },
  menu: { view: PERMISSIONS.SETTINGS_HEADER_EDIT, edit: PERMISSIONS.SETTINGS_HEADER_EDIT },
  shipping_method: { view: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW, edit: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT },
  payment_method: { view: PERMISSIONS.SETTINGS_GENERAL_VIEW, edit: PERMISSIONS.SETTINGS_GENERAL_EDIT },
};

/** The kinds this role may read, in tab order: the tabs Translate & adapt shows it. */
export function readableTranslationTypes(hasPermission: (permission: string) => boolean): TranslationResourceType[] {
  return TRANSLATION_RESOURCE_TYPES.filter((type) => hasPermission(TRANSLATION_TYPE_PERMISSIONS[type].view));
}
