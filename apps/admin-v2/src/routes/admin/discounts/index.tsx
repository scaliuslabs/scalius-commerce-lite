import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DISCOUNT_TABS, DiscountList, type DiscountTab } from "~/components/admin/discounts/DiscountList";
import { usePermissions } from "~/contexts/PermissionContext";
import { translate } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { discountsQueryOptions } from "~/lib/api-query-options/discounts";
import { RouteErrorComponent } from "~/lib/route-error";

interface DiscountListSearch {
  tab?: DiscountTab;
  q?: string;
}

export function validateDiscountListSearch(search: Record<string, unknown>): DiscountListSearch {
  const tab = DISCOUNT_TABS.find((item) => item === search.tab && item !== "all");
  const q = typeof search.q === "string" ? search.q.slice(0, 120) : "";
  return { ...(tab ? { tab } : {}), ...(q ? { q } : {}) };
}

export const Route = createFileRoute("/admin/discounts/")({
  validateSearch: validateDiscountListSearch,
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(discountsQueryOptions()),
  head: () => ({ meta: [{ title: `${translate(discountsMessages, "pageTitle")} | Scalius Admin` }] }),
  errorComponent: RouteErrorComponent,
  component: DiscountsPage,
});

function DiscountsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { hasPermission } = usePermissions();
  const { data: discounts } = useSuspenseQuery(discountsQueryOptions());
  const setSearch = (patch: DiscountListSearch) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace: true });

  return (
    <DiscountList
      discounts={discounts}
      tab={search.tab ?? "all"}
      query={search.q ?? ""}
      canCreate={hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_CREATE)}
      onTabChange={(tab) => setSearch({ tab: tab === "all" ? undefined : tab })}
      onQueryChange={(q) => setSearch({ q: q || undefined })}
    />
  );
}
