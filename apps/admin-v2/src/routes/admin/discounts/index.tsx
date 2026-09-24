import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DISCOUNT_SORTS, DISCOUNT_TABS, DiscountList, type DiscountSort, type DiscountTab } from "~/components/admin/discounts/DiscountList";
import { translate } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { discountsQueryOptions } from "~/lib/api-query-options/discounts";
import { RouteErrorComponent } from "~/lib/route-error";

interface DiscountListSearch {
  tab?: DiscountTab;
  sort?: DiscountSort;
}

/** The view tab and sort are shareable; the search (discount codes) stays out of the URL. */
export function validateDiscountListSearch(search: Record<string, unknown>): DiscountListSearch {
  const tab = DISCOUNT_TABS.find((item) => item === search.tab && item !== "all");
  const sort = DISCOUNT_SORTS.find((item) => item === search.sort && item !== "updated");
  return { ...(tab ? { tab } : {}), ...(sort ? { sort } : {}) };
}

export const Route = createFileRoute("/admin/discounts/")({
  validateSearch: validateDiscountListSearch,
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(discountsQueryOptions()),
  head: () => ({ meta: [{ title: `${translate(discountsMessages, "pageTitle")} | Scalius Admin` }] }),
  errorComponent: RouteErrorComponent,
  component: DiscountsPage,
});

function DiscountsPage() {
  const { tab, sort } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: discounts } = useSuspenseQuery(discountsQueryOptions());

  return (
    <DiscountList
      discounts={discounts}
      tab={tab ?? "all"}
      sort={sort ?? "updated"}
      onTabChange={(next) => void navigate({ search: (previous) => ({ ...previous, tab: next === "all" ? undefined : next }), replace: true })}
      onSortChange={(next) => void navigate({ search: (previous) => ({ ...previous, sort: next === "updated" ? undefined : next }), replace: true })}
    />
  );
}
