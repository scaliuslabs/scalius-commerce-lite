import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { MarketsList } from "~/components/admin/settings/markets/MarketsList";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/markets")({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(marketsQueryOptions()).catch(() => undefined),
  head: () => settingsHead("markets"),
  errorComponent: RouteErrorComponent,
  component: MarketsPage,
});

function MarketsPage() {
  return (
    <SettingsPage page="markets">
      <MarketsList />
    </SettingsPage>
  );
}
