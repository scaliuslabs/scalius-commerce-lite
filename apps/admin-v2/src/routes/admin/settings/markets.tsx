import { createFileRoute } from "@tanstack/react-router";
import { AppProviderSheetHost } from "~/components/admin/apps/AppProviderSheetHost";
import { AppKindCard } from "~/components/admin/settings/AppKindCard";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { MarketsList } from "~/components/admin/settings/markets/MarketsList";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import { appProvidersQuery } from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/markets")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(marketsQueryOptions()),
      queryClient.ensureQueryData(appProvidersQuery("fx")),
    ]),
  head: () => settingsHead("markets"),
  errorComponent: RouteErrorComponent,
  component: MarketsPage,
});

function MarketsPage() {
  return (
    <AppProviderSheetHost>
      <SettingsPage page="markets">
        <MarketsList />
        <AppKindCard kind="fx" />
      </SettingsPage>
    </AppProviderSheetHost>
  );
}
