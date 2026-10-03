import { createFileRoute } from "@tanstack/react-router";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { MarketEditor } from "~/components/admin/settings/markets/MarketEditor";
import { marketEditorQueryOptions } from "~/components/admin/settings/markets/market-form";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import { RouteErrorComponent } from "~/lib/route-error";

// One market, Shopify style: name and status, countries, currency, web
// presence and price increment, then delete at the bottom.
export const Route = createFileRoute("/admin/settings/markets_/$marketId")({
  loader: ({ context: { queryClient }, params: { marketId } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(marketEditorQueryOptions(marketId)),
      queryClient.ensureQueryData(marketsQueryOptions()),
    ]),
  head: () => settingsHead("markets"),
  errorComponent: RouteErrorComponent,
  component: MarketPage,
});

function MarketPage() {
  const { marketId } = Route.useParams();
  // A fresh editor per market: switching markets never carries a draft over.
  return <MarketEditor key={marketId} marketId={marketId} />;
}
