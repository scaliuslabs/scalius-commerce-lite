import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { TicketPercent } from "lucide-react";

import { DiscountBulkActions, discountTitle, useDiscountColumns } from "~/components/admin/discounts/DiscountList";
import { DiscountTypeDialog } from "~/components/admin/discounts/DiscountTypeDialog";
import { DISCOUNT_SORTS, DISCOUNT_TABS } from "~/components/admin/discounts/discount-kinds";
import { ResourceListPage } from "~/components/admin/resource/ResourceListPage";
import { Button } from "~/components/ui/button";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { pageHead } from "~/i18n/page-titles";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { discountsQueryOptions, type DiscountListItem } from "~/lib/api-query-options/discounts";
import {
  createListSearchValidator,
  normalizeOptionalEnumSearchParam,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { adoptListSearch, listSearchKey, useListSearch } from "~/lib/list-search";
import { queryKeys } from "~/lib/query-keys";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";

const VIEWS = DISCOUNT_TABS.filter((tab) => tab !== "all");
const validateBase = createListSearchValidator(DISCOUNT_SORTS, { sort: "updatedAt", list: "discounts" });

/** The view tab, sort and page are shareable; the search (discount codes) stays out of the URL. */
export function validateDiscountListSearch(search: SearchValidatorInput) {
  return { ...validateBase(search), tab: normalizeOptionalEnumSearchParam(search.tab, VIEWS) };
}

type DiscountListSearch = ReturnType<typeof validateDiscountListSearch>;

/** One page of discounts, searched, filtered and sorted on the server. */
function listQuery(search: DiscountListSearch, term: string) {
  return discountsQueryOptions({
    page: search.page,
    limit: search.limit,
    ...(term ? { search: term } : {}),
    ...(search.tab ? { view: search.tab } : {}),
    sort: search.sort === "title" ? (search.order === "desc" ? "titleDesc" : "titleAsc") : "updated",
  });
}

export const Route = createFileRoute("/admin/discounts/")({
  validateSearch: validateDiscountListSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps, adoptListSearch(listSearchKey("discounts", deps, "tab"), deps.q))),
  head: () => pageHead("discounts"),
  errorComponent: RouteErrorComponent,
  component: DiscountsPage,
});

/** Shopify's Discounts index: code and automatic discounts in one list. */
function DiscountsPage() {
  const search = Route.useSearch();
  const t = useMessages(discountsMessages);
  const [term] = useListSearch(listSearchKey("discounts", search, "tab"));
  const { hasPermission } = usePermissions();
  const [chooserOpen, setChooserOpen] = useState(false);
  const columns = useDiscountColumns();
  const canCreate = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_CREATE);
  const canToggle = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_TOGGLE_STATUS);
  const canDelete = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_DELETE);
  const create = canCreate ? <Button type="button" onClick={() => setChooserOpen(true)}>{t("createDiscount")}</Button> : undefined;

  return (
    <>
      <ResourceListPage<DiscountListItem>
        title={t("pageTitle")}
        actions={create}
        search={search}
        list="discounts"
        query={listQuery(search, term)}
        dataKey="discounts"
        columns={columns}
        what={t("whatDiscounts")}
        invalidate={[queryKeys.discounts.all]}
        empty={{ icon: TicketPercent, title: t("emptyTitle"), description: t("emptyBody"), action: create }}
        views={{ param: "tab", tabs: VIEWS.map((tab) => ({ value: tab, label: t(tab === "active" ? "tabActive" : tab === "scheduled" ? "tabScheduled" : "tabExpired") })) }}
        searchPlaceholder={t("searchPlaceholder")}
        rowTo={(row) => `/admin/discounts/${row.id}`}
        rowLabel={discountTitle}
        bulkActions={canToggle || canDelete ? (target, done) => (
          target.kind === "rows" ? <DiscountBulkActions rows={target.rows} done={done} canToggle={canToggle} canDelete={canDelete} /> : null
        ) : undefined}
      />
      <DiscountTypeDialog open={chooserOpen} onOpenChange={setChooserOpen} />
    </>
  );
}
