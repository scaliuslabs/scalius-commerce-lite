import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/i18n/page-titles";
import { ImportExportHub } from "~/components/admin/store-transfer/ImportExportHub";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/import-export")({
  head: () => settingsHead("importExport"),
  errorComponent: RouteErrorComponent,
  component: ImportExportPage,
});

function ImportExportPage() {
  return (
    <SettingsPage page="importExport">
      <ImportExportHub />
    </SettingsPage>
  );
}
