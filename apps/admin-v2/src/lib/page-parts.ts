// The reads a dashboard page makes after it opens, in a part a role may or may
// not be shown: a tab, a dialog or a menu that loads its own list. Each names
// the permission the API checks for that read (a handler's own per-kind check
// as well as the route map) and whether the page shows the part to a role, by
// the same function the page uses. The page and route census
// (routes/-page-route-permissions.test.ts) holds every declared part to the
// API, for every smallest role that opens the page, and fails on a file that
// draws tabs without declaring them or a reviewed reason they read nothing a
// role could be refused.
import type { PermissionName } from "@scalius/core/auth/rbac/types";
import { TRANSLATION_RESOURCE_TYPES, TRANSLATION_TYPE_PERMISSIONS, readableTranslationTypes } from "@scalius/core/auth/rbac/translation-permissions";

export interface PagePartRead {
  /** The page path, as `getAdminPagePermission` names it. */
  page: string;
  /** The component file (below `src/`) that draws the part. */
  file: string;
  part: string;
  read: { method: "GET"; path: string; query: Record<string, string> };
  /** What the API checks for the read beyond its route rule. */
  permission: PermissionName;
  /** Whether the page shows the part to a role with these permissions. */
  shown: (hasPermission: (permission: string) => boolean) => boolean;
}

export const PAGE_PART_READS: readonly PagePartRead[] = [
  // Translate & adapt: one tab per kind of resource, each listed by the kind's own view permission.
  ...TRANSLATION_RESOURCE_TYPES.map((type): PagePartRead => ({
    page: "/admin/translations",
    file: "components/admin/translations/TranslationsWorkspace.tsx",
    part: `tab:${type}`,
    read: { method: "GET", path: "/api/v1/admin/translations/resources", query: { type } },
    permission: TRANSLATION_TYPE_PERMISSIONS[type].view,
    shown: (hasPermission) => readableTranslationTypes(hasPermission).includes(type),
  })),
];

/**
 * Files that draw tabs whose parts make no read a role that sees the page
 * could be refused (reviewed one by one): their tabs switch what is on screen,
 * or every tab reads under the page's own permission.
 */
export const TABS_WITHOUT_GATED_READS: Readonly<Record<string, string>> = {
  "components/admin/apps/AppActivity.tsx": "deliveries and log are both read under apps.view, the page's own permission",
  "components/admin/collection-form/CollectionContentSection.tsx": "switches between content editors; reads nothing",
  "components/admin/discounts/DiscountEditor.tsx": "code or automatic: switches fields; reads nothing",
  "components/admin/inbox/ConversationComposer.tsx": "reply or internal note: switches the composer; reads nothing",
  "components/admin/online-store/NavigationResourcePicker.tsx": "every kind is read from /navigation/resources under settings.header.edit, the menu editor's own permission",
  "components/admin/online-store/theme-fields.tsx": "light or dark colours: switches fields; reads nothing",
  "components/admin/online-store/theme-editor/ThemeEditor.tsx": "sections or theme settings: switches panes of one loaded theme",
  "components/admin/settings/DeliveryAreas.tsx": "place levels, all read from /settings/delivery-locations under the page's own permission",
  "routes/admin/apps/$pluginId_.pages.$pageId.tsx": "an app page's own tabs, drawn from the surface the page already read (apps.use)",
  "components/ui/tabs.tsx": "the tabs primitive itself",
};
