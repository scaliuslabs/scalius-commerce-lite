// Who may translate what (docs/MARKETS-DESIGN.md D9): each resource type's own
// view and edit permissions, the table the API checks (core
// rbac/translation-permissions.ts).
import { TRANSLATION_TYPE_PERMISSIONS } from "@scalius/core/auth/rbac/translation-permissions";
import type { TranslationEditorType } from "~/lib/translation-types";

export { readableTranslationTypes } from "@scalius/core/auth/rbac/translation-permissions";

export function canEditTranslations(hasPermission: (permission: string) => boolean, type: TranslationEditorType): boolean {
  return hasPermission(TRANSLATION_TYPE_PERMISSIONS[type].edit);
}
