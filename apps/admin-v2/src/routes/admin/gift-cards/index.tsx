import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { GiftCardList } from "~/components/admin/gift-cards/GiftCardList";
import { giftCardListQuery, validateGiftCardListSearch } from "~/components/admin/gift-cards/gift-card-list-state";
import { translate } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { titleHead } from "~/i18n/page-titles";
import { giftCardsQueryOptions, giftCardSummaryQueryOptions } from "~/lib/api-query-options/gift-cards";
import { readListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";

export const Route = createFileRoute("/admin/gift-cards/")({
  // Only the status tab is shareable; the search stays in this tab's session.
  validateSearch: validateGiftCardListSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) =>
    Promise.all([
      warmRouteQuery(queryClient, giftCardsQueryOptions(giftCardListQuery(deps.status ?? "all", readListSearch("giftCards"), ""))),
      warmRouteQuery(queryClient, giftCardSummaryQueryOptions()),
    ]),
  head: () => titleHead(translate(shellMessages, "giftCards")),
  errorComponent: RouteErrorComponent,
  component: GiftCardsPage,
});

function GiftCardsPage() {
  const { status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <GiftCardList
      tab={status ?? "all"}
      onTabChange={(next) => void navigate({ search: { ...(next === "all" ? {} : { status: next }) }, replace: true })}
    />
  );
}
