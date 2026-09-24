import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DISCOUNT_TABS, DiscountList, type DiscountTab } from "~/components/admin/discounts/DiscountList";
import { translate } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { discountsQueryOptions } from "~/lib/api-query-options/discounts";
import { RouteErrorComponent } from "~/lib/route-error";

/** Only the view tab is shareable; the search (discount codes) stays out of the URL. */
export function validateDiscountListSearch(search: Record<string, unknown>): { tab?: DiscountTab } {
  const tab = DISCOUNT_TABS.find((item) => item === search.tab && item !== "all");
  return tab ? { tab } : {};
}

export const Route = createFileRoute("/admin/discounts/")({
  validateSearch: validateDiscountListSearch,
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(discountsQueryOptions()),
  head: () => ({ meta: [{ title: `${translate(discountsMessages, "pageTitle")} | Scalius Admin` }] }),
  errorComponent: RouteErrorComponent,
  component: DiscountsPage,
});

function DiscountsPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: discounts } = useSuspenseQuery(discountsQueryOptions());

  return (
    <DiscountList
      discounts={discounts}
      tab={tab ?? "all"}
      onTabChange={(next) => void navigate({ search: next === "all" ? {} : { tab: next }, replace: true })}
    />
  );
}
