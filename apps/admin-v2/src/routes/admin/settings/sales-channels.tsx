import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { SalesChannelsSettings } from "~/components/admin/settings/sales-channels/SalesChannelsSettings";
import { salesChannelsQueryOptions } from "~/lib/api-query-options/sales-channels";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/sales-channels")({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(salesChannelsQueryOptions()).catch(() => undefined),
  head: () => settingsHead("salesChannels"),
  errorComponent: RouteErrorComponent,
  component: SalesChannelsPage,
});

function SalesChannelsPage() {
  return (
    <SettingsPage page="salesChannels">
      <SalesChannelsSettings />
    </SettingsPage>
  );
}
