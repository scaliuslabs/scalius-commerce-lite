// Who may translate what (docs/MARKETS-DESIGN.md D9): each resource type's own
// edit permission, the same the API checks (routes/admin/translations.ts).
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import type { TranslationEditorType } from "~/lib/api-query-options/translations";

export const TRANSLATION_EDIT_PERMISSION: Record<TranslationEditorType, string> = {
  product: PERMISSIONS.PRODUCTS_EDIT,
  collection: PERMISSIONS.COLLECTIONS_EDIT,
  category: PERMISSIONS.CATEGORIES_EDIT,
  brand: PERMISSIONS.CATEGORIES_EDIT,
  page: PERMISSIONS.PAGES_EDIT,
  menu: PERMISSIONS.SETTINGS_HEADER_EDIT,
  shipping_method: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT,
  payment_method: PERMISSIONS.SETTINGS_GENERAL_EDIT,
};

export function canEditTranslations(hasPermission: (permission: string) => boolean, type: TranslationEditorType): boolean {
  return hasPermission(TRANSLATION_EDIT_PERMISSION[type]);
}
