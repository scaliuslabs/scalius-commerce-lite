import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DiscountList } from "~/components/admin/discounts/DiscountList";
import { DISCOUNT_SORTS, DISCOUNT_TABS, type DiscountSort, type DiscountTab } from "~/components/admin/discounts/discount-kinds";
import { discountsQueryOptions } from "~/lib/api-query-options/discounts";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

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
  head: () => pageHead("discounts"),
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
