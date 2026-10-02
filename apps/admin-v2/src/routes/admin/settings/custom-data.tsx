import { createFileRoute } from "@tanstack/react-router";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { CustomDataSettings } from "~/components/admin/settings/custom-data/CustomDataSettings";
import { RouteErrorComponent } from "~/lib/route-error";
import { useHasPermission } from "~/contexts/PermissionContext";

export const Route = createFileRoute("/admin/settings/custom-data")({
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const { customFieldDefinitionsQueryOptions: options } = await import("~/lib/api-query-options/custom-fields");
    return queryClient.ensureQueryData(options()).catch(() => undefined);
  },
  head: () => settingsHead("customData"),
  errorComponent: RouteErrorComponent,
  component: CustomDataPage,
});

function CustomDataPage() {
  const canEdit = useHasPermission(PERMISSIONS.SETTINGS_GENERAL_EDIT);
  return (
    <SettingsPage page="customData" readOnly={!canEdit}>
      <CustomDataSettings />
    </SettingsPage>
  );
}
