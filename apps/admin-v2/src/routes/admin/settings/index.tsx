import { createFileRoute, redirect } from "@tanstack/react-router";
import { SETTINGS_NAV } from "~/components/admin/settings/settings-nav";
import { SettingsNav } from "~/components/admin/settings/SettingsNav";
import { canAccessAdminPath } from "~/lib/admin-access";
import { useMessages } from "~/i18n";
import { settingsNavMessages } from "~/i18n/settings";
import { pageHead } from "~/i18n/page-titles";

// Shopify: on a desktop the settings list is the panel's left column, so the
// first page opens directly; on a phone this route is the list itself.
export const Route = createFileRoute("/admin/settings/")({
  beforeLoad: ({ context }) => {
    if (typeof window === "undefined" || !window.matchMedia("(min-width: 1024px)").matches) return;
    const first = SETTINGS_NAV.find((item) => canAccessAdminPath(item.to, context));
    if (first) throw redirect({ to: first.to, replace: true });
  },
  head: () => pageHead("settings"),
  component: SettingsIndex,
});

function SettingsIndex() {
  const t = useMessages(settingsNavMessages);
  return (
    <div className="space-y-4 lg:hidden">
      <h1 className="flex min-h-11 items-center pr-10 text-heading-lg">{t("settings")}</h1>
      <SettingsNav variant="rows" />
    </div>
  );
}
