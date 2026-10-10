import { lazy, Suspense, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { DataTableSortMenu, type SortField } from "~/components/admin/data-table/DataTableSortMenu";
import { useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";
import { CLEARED_ORDER_FILTERS, countOrderFilters, type OrderListSearch } from "./order-list-search";

const OrderListFilters = lazy(() => import("./OrderListFilters").then((module) => ({ default: module.OrderListFilters })));

interface OrderListToolbarProps {
  search: OrderListSearch;
  /** The search term (kept in this tab's session, not the URL). */
  term: string;
  onSearch: (term: string) => void;
  onChange: (updates: Partial<OrderListSearch>) => void;
  /** An active app has a column to filter by (loads the app filter field). */
  appFilterable?: boolean;
  /** The bulk bar while orders are selected. */
  bulkBar?: ReactNode;
  /** The live list's offer to load new orders or changes (use-live-order-list.ts). */
  live: { newCount: number; stale: boolean; showLatest: () => void };
}

/** The orders list's sort menu: the fields the API sorts orders by, with their own direction words. */
export function OrderSortMenu({ search, term, onChange }: { search: OrderListSearch; term: string; onChange: (updates: Partial<OrderListSearch>) => void }) {
  const t = useMessages(orderListMessages);
  const fields: SortField[] = [
    ...(term.trim() ? [{ id: "relevance", label: t("sort.relevance:desc"), directions: 1 as const, desc: true }] : []),
    { id: "createdAt", label: t("sortField.createdAt"), descLabel: t("sort.createdAt:desc"), ascLabel: t("sort.createdAt:asc"), desc: true },
    { id: "updatedAt", label: t("sort.updatedAt:desc"), directions: 1, desc: true },
    { id: "totalAmount", label: t("sortField.totalAmount"), descLabel: t("sort.totalAmount:desc"), ascLabel: t("sort.totalAmount:asc"), desc: true },
    { id: "customerName", label: t("sort.customerName:asc"), directions: 1, desc: false },
  ];
  return (
    <DataTableSortMenu
      fields={fields}
      value={{ id: search.sort, desc: search.order === "desc" }}
      defaultLabel={false}
      onChange={(next) => {
        const sort = (next?.id ?? "createdAt") as OrderListSearch["sort"];
        onChange({ sort, order: next?.desc === false ? "asc" : "desc", page: 1 });
      }}
    />
  );
}

/**
 * The orders toolbar on the list kit: search, Filters (the panel below holds
 * every order filter), the sort and columns menus, and the live list's
 * "3 new orders" offer.
 */
export function OrderListToolbar({
  search,
  term,
  onSearch,
  onChange,
  appFilterable = false,
  bulkBar,
  live,
}: OrderListToolbarProps) {
  const t = useMessages(orderListMessages);
  const filterCount = countOrderFilters(search);

  return (
    <DataTableToolbar
      searchValue={term}
      onSearchChange={onSearch}
      searchPlaceholder={t("searchPlaceholder")}
      bulkBar={bulkBar}
      filterCount={filterCount}
      onClearFilters={() => onChange(CLEARED_ORDER_FILTERS)}
      extra={
        // Polite and still: the offer appears, it never flashes or moves rows.
        <span aria-live="polite" className="contents">
          {live.newCount > 0 || live.stale ? (
            <Button variant="secondary" onClick={live.showLatest}>
              <RefreshCw className="h-4 w-4" />
              {live.newCount > 0 ? t("newOrders", { count: live.newCount }) : t("ordersUpdated")}
            </Button>
          ) : null}
        </span>
      }
      filters={
        <Suspense fallback={<Skeleton className="col-span-full h-15 w-full" />}>
          <OrderListFilters search={search} onChange={onChange} appFilterable={appFilterable} />
        </Suspense>
      }
    />
  );
}
