import { createFileRoute } from "@tanstack/react-router";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/i18n/page-titles";
import { CustomDataSettings } from "~/components/admin/settings/custom-data/CustomDataSettings";
import { customFieldDefinitionsQueryOptions } from "~/lib/api-query-options/custom-fields";
import { RouteErrorComponent } from "~/lib/route-error";
import { useHasPermission } from "~/contexts/PermissionContext";

export const Route = createFileRoute("/admin/settings/custom-data")({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(customFieldDefinitionsQueryOptions()).catch(() => undefined),
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
