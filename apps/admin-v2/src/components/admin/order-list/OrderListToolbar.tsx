import { lazy, Suspense, useState, type ReactNode } from "react";
import { Calendar as CalendarIcon, ListFilter, RefreshCw, X } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { ORDER_STATUSES } from "@scalius/shared/order-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { formatDateOnly, parseDateOnly } from "~/lib/date-only";
import { formatDateTime, useMessages } from "~/i18n";
import {
  fulfillmentStatusLabel,
  orderMessages,
  orderStatusLabel,
  paymentMethodLabel,
  paymentStatusLabel,
} from "~/i18n/orders";
import { orderListMessages } from "~/i18n/order-list";
import type { OrderRefreshPause } from "./order-bulk-actions";
import {
  CLEARED_ORDER_FILTERS,
  countOrderFilters,
  FULFILLMENT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_RECOVERY_STATES,
  PAYMENT_STATUSES,
  type OrderListSearch,
} from "./order-list-search";

const DateRangePickerWithPresets = lazy(() =>
  import("./DateRangePickerWithPresets").then((module) => ({
    default: module.DateRangePickerWithPresets,
  })),
);

const ANY = "any";
const SORT_OPTIONS = [
  "createdAt:desc",
  "createdAt:asc",
  "updatedAt:desc",
  "totalAmount:desc",
  "totalAmount:asc",
  "customerName:asc",
] as const;

interface OrderListToolbarProps {
  search: OrderListSearch;
  /** The search term (kept in this tab's session, not the URL). */
  term: string;
  onSearch: (term: string) => void;
  onChange: (updates: Partial<OrderListSearch>) => void;
  selectedCount: number;
  bulkActions: ReactNode;
  autoRefresh: { enabled: boolean; toggle: () => void; pause: OrderRefreshPause | null };
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  children: ReactNode;
}) {
  const t = useMessages(orderListMessages);
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value ?? ANY} onValueChange={(next) => onChange(next === ANY ? undefined : next)}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{t("any")}</SelectItem>
          {children}
        </SelectContent>
      </Select>
    </div>
  );
}

function DateRangeFilter({
  search,
  onChange,
}: {
  search: OrderListSearch;
  onChange: (range: DateRange | undefined) => void;
}) {
  const t = useMessages(orderListMessages);
  const [loadPicker, setLoadPicker] = useState(false);
  const range: DateRange | undefined =
    search.startDate || search.endDate
      ? { from: parseDateOnly(search.startDate), to: parseDateOnly(search.endDate) }
      : undefined;
  const format = (date: Date) => formatDateTime(date, { dateStyle: "medium", timeZone: undefined });
  const label = !range?.from
    ? t("anyDate")
    : range.to
      ? `${format(range.from)} – ${format(range.to)}`
      : format(range.from);
  const trigger = (
    <Button variant="outline" className="w-full justify-start" onClick={() => setLoadPicker(true)}>
      <CalendarIcon className="h-4 w-4" />
      <span className="truncate">{label}</span>
    </Button>
  );
  return (
    <div className="space-y-1">
      <Label>{t("date")}</Label>
      {loadPicker ? (
        <Suspense fallback={trigger}>
          <DateRangePickerWithPresets date={range} setDate={onChange} trigger={trigger} />
        </Suspense>
      ) : (
        trigger
      )}
    </div>
  );
}

/** One row: search, Filters, sort and auto-refresh; the filter fields open below it. */
export function OrderListToolbar({
  search,
  term,
  onSearch,
  onChange,
  selectedCount,
  bulkActions,
  autoRefresh,
}: OrderListToolbarProps) {
  const t = useMessages(orderListMessages);
  const to = useMessages(orderMessages);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterCount = countOrderFilters(search);
  const filter = (patch: Partial<OrderListSearch>) => onChange({ ...patch, page: 1 });
  const sortOptions: ReadonlyArray<(typeof SORT_OPTIONS)[number] | "relevance:desc"> =
    term.trim() ? ["relevance:desc", ...SORT_OPTIONS] : SORT_OPTIONS;

  return (
    <div className="space-y-2 pb-2">
      <DataTableToolbar
        searchValue={term}
        onSearchChange={onSearch}
        searchPlaceholder={t("searchPlaceholder")}
        selectedCount={selectedCount}
        bulkActions={bulkActions}
        filters={
          // With rows selected the bulk actions take this row's place on wide screens
          // (as in Shopify), so nothing wraps onto a second line.
          <div className={selectedCount > 0 ? "contents md:hidden" : "contents"}>
            <Button
              variant="outline"
              aria-expanded={filtersOpen}
              aria-controls="order-filters"
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <ListFilter className="h-4 w-4" />
              {filterCount > 0 ? t("filtersCount", { count: filterCount }) : t("filters")}
            </Button>
            <Select
              value={`${search.sort}:${search.order}`}
              onValueChange={(value) => {
                const [sort, order] = value.split(":") as [OrderListSearch["sort"], "asc" | "desc"];
                onChange({ sort, order, page: 1 });
              }}
            >
              <SelectTrigger className="w-auto" aria-label={t("sort")}>
                <SelectValue placeholder={t("sort")} />
              </SelectTrigger>
              <SelectContent>
                {sortOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`sort.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={autoRefresh.enabled ? "secondary" : "ghost"}
              aria-pressed={autoRefresh.enabled}
              title={autoRefresh.enabled && autoRefresh.pause ? t(`pause.${autoRefresh.pause}`) : undefined}
              onClick={autoRefresh.toggle}
            >
              <RefreshCw className="h-4 w-4" />
              {t("autoRefresh")}
            </Button>
          </div>
        }
      />

      {filtersOpen ? (
        <div id="order-filters" className="space-y-4 border-t pt-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FilterSelect label={t("orderStatus")} value={search.status} onChange={(status) => filter({ status })}>
              {ORDER_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {orderStatusLabel(to, status)}
                </SelectItem>
              ))}
            </FilterSelect>
            <FilterSelect
              label={t("payment")}
              value={search.paymentStatus}
              onChange={(value) => filter({ paymentStatus: value as OrderListSearch["paymentStatus"] })}
            >
              {PAYMENT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {paymentStatusLabel(to, status)}
                </SelectItem>
              ))}
            </FilterSelect>
            <FilterSelect
              label={t("paymentMethod")}
              value={search.paymentMethod}
              onChange={(value) => filter({ paymentMethod: value as OrderListSearch["paymentMethod"] })}
            >
              {PAYMENT_METHODS.map((method) => (
                <SelectItem key={method} value={method}>
                  {paymentMethodLabel(to, method)}
                </SelectItem>
              ))}
            </FilterSelect>
            <FilterSelect
              label={t("fulfillment")}
              value={search.fulfillmentStatus}
              onChange={(value) =>
                filter({ fulfillmentStatus: value as OrderListSearch["fulfillmentStatus"] })}
            >
              {FULFILLMENT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {fulfillmentStatusLabel(to, status)}
                </SelectItem>
              ))}
            </FilterSelect>
            <FilterSelect
              label={t("onlinePayment")}
              value={search.paymentRecovery}
              onChange={(value) =>
                filter({ paymentRecovery: value as OrderListSearch["paymentRecovery"] })}
            >
              {PAYMENT_RECOVERY_STATES.map((state) => (
                <SelectItem key={state} value={state}>
                  {t(`recovery.${state}`)}
                </SelectItem>
              ))}
            </FilterSelect>
            <DateRangeFilter
              search={search}
              onChange={(range) =>
                filter({ startDate: formatDateOnly(range?.from), endDate: formatDateOnly(range?.to) })}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="order-filter-open-request"
                  checked={search.openRequest}
                  onCheckedChange={(checked) => filter({ openRequest: checked === true })}
                />
                <Label htmlFor="order-filter-open-request">{t("openRequestFilter")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="order-filter-archived"
                  checked={search.archived}
                  onCheckedChange={(checked) => filter({ archived: checked === true })}
                />
                <Label htmlFor="order-filter-archived">{t("showArchived")}</Label>
              </div>
            </div>
            {filterCount > 0 ? (
              <Button variant="ghost" onClick={() => onChange(CLEARED_ORDER_FILTERS)}>
                <X className="h-4 w-4" />
                {t("clearFilters")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
