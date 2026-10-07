import { createFileRoute, redirect } from "@tanstack/react-router";
import { SETTINGS_NAV } from "~/components/admin/settings/settings-nav";
import { SettingsNav } from "~/components/admin/settings/SettingsNav";
import { canAccessAdminPath } from "~/lib/admin-access";
import { useMessages } from "~/i18n";
import { settingsNavMessages } from "~/i18n/settings";
import { pageHead } from "~/i18n/page-titles";

// Shopify: where the navigation panel shows, the settings list is in it, so
// the first page opens directly; with the menu drawer this route is the list
// itself. The width is NAV_PANEL_QUERY (layout/nav-button.ts), written out so
// this route chunk does not pull the navigation's styles into the entry.
export const Route = createFileRoute("/admin/settings/")({
  beforeLoad: ({ context }) => {
    if (typeof window === "undefined" || !window.matchMedia("(min-width: 1100px)").matches) return;
    const first = SETTINGS_NAV.find((item) => canAccessAdminPath(item.to, context));
    if (first) throw redirect({ to: first.to, replace: true });
  },
  head: () => pageHead("settings"),
  component: SettingsIndex,
});

function SettingsIndex() {
  const t = useMessages(settingsNavMessages);
  return (
    <div className="space-y-4 nav:hidden">
      <h1 className="flex min-h-11 items-center text-heading-lg">{t("settings")}</h1>
      <SettingsNav variant="rows" />
    </div>
  );
}
