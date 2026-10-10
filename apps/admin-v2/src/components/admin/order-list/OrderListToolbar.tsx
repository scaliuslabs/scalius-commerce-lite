import { lazy, Suspense, useState, type ReactNode } from "react";
import { Calendar as CalendarIcon, RefreshCw } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { ORDER_STATUSES } from "@scalius/shared/order-state";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { useAppPaymentMethodNames } from "~/hooks/use-app-payment-method-names";
import { SearchableSelect, type SearchableSelectOption } from "~/components/ui/searchable-select";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { DataTableSortMenu, type SortField } from "~/components/admin/data-table/DataTableSortMenu";
import { formatDateOnly, parseDateOnly } from "~/lib/date-only";
import { formatDateTime, useMessages } from "~/i18n";
import {
  deliveryMethodLabel,
  fulfillmentStatusLabel,
  orderChannelLabel,
  orderMessages,
  orderStatusLabel,
  paymentMethodLabel,
  paymentStatusLabel,
} from "~/i18n/orders";
import { orderListMessages } from "~/i18n/order-list";
import {
  CLEARED_ORDER_FILTERS,
  countOrderFilters,
  DELIVERY_METHODS,
  FULFILLMENT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_RECOVERY_STATES,
  PAYMENT_STATUSES,
  SALES_CHANNELS,
  type OrderListSearch,
} from "./order-list-search";
import { Field, FieldSet } from "~/components/ui/field";

const DateRangePickerWithPresets = lazy(() =>
  import("./DateRangePickerWithPresets").then((module) => ({
    default: module.DateRangePickerWithPresets,
  })),
);

// The app filter field loads when the filters open and an app has a column to filter by.
const AppListFilter = lazy(() => import("~/components/admin/apps/AppListFilter").then((module) => ({ default: module.AppListFilter })));

const ANY = "any";

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

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: SearchableSelectOption[];
}) {
  const t = useMessages(orderListMessages);
  return (
    <Field label={label}>
      <SearchableSelect
        triggerClassName="w-full"
        value={value ?? ANY}
        onValueChange={(next) => onChange(next === ANY ? undefined : next)}
        options={[{ value: ANY, label: t("any") }, ...options]}
      />
    </Field>
  );
}

/**
 * Cash, the built-in gateways and the installed apps' methods (read when the
 * filters open); a filtered app method stays listed after its app is removed.
 */
function PaymentMethodFilter({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  const t = useMessages(orderListMessages);
  const to = useMessages(orderMessages);
  const appNames = useAppPaymentMethodNames(true);
  const methods = [...new Set<string>([
    ...PAYMENT_METHODS,
    ...(appNames?.keys() ?? []),
    ...(value && isQualifiedProviderId(value) ? [value] : []),
  ])];
  return (
    <FilterSelect
      label={t("paymentMethod")}
      value={value}
      onChange={onChange}
      options={methods.map((method) => ({ value: method, label: paymentMethodLabel(to, method, appNames) }))}
    />
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
    <Button id="order-filter-date" variant="outline" className="w-full justify-start" onClick={() => setLoadPicker(true)}>
      <CalendarIcon className="h-4 w-4" />
      <span className="truncate" title={label}>{label}</span>
    </Button>
  );
  return (
    <FieldSet label={t("date")}>
      {loadPicker ? (
        <Suspense fallback={trigger}>
          <DateRangePickerWithPresets date={range} setDate={onChange} trigger={trigger} />
        </Suspense>
      ) : (
        trigger
      )}
    </FieldSet>
  );
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
  const to = useMessages(orderMessages);
  const filterCount = countOrderFilters(search);
  const filter = (patch: Partial<OrderListSearch>) => onChange({ ...patch, page: 1 });

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
        <>
          <FilterSelect
            label={t("orderStatus")}
            value={search.status}
            onChange={(status) => filter({ status })}
            options={ORDER_STATUSES.map((status) => ({ value: status, label: orderStatusLabel(to, status) }))}
          />
          <FilterSelect
            label={t("payment")}
            value={search.paymentStatus}
            onChange={(value) => filter({ paymentStatus: value as OrderListSearch["paymentStatus"] })}
            options={PAYMENT_STATUSES.map((status) => ({ value: status, label: paymentStatusLabel(to, status) }))}
          />
          <PaymentMethodFilter value={search.paymentMethod} onChange={(paymentMethod) => filter({ paymentMethod })} />
          <FilterSelect
            label={t("fulfillment")}
            value={search.fulfillmentStatus}
            onChange={(value) => filter({ fulfillmentStatus: value as OrderListSearch["fulfillmentStatus"] })}
            options={FULFILLMENT_STATUSES.map((status) => ({ value: status, label: fulfillmentStatusLabel(to, status) }))}
          />
          <FilterSelect
            label={t("deliveryMethod")}
            value={search.deliveryMethod}
            onChange={(value) => filter({ deliveryMethod: value as OrderListSearch["deliveryMethod"] })}
            options={DELIVERY_METHODS.map((method) => ({ value: method, label: deliveryMethodLabel(to, method) }))}
          />
          <FilterSelect
            label={t("salesChannel")}
            value={search.channel}
            onChange={(value) => filter({ channel: value as OrderListSearch["channel"] })}
            options={SALES_CHANNELS.map((channel) => ({ value: channel, label: orderChannelLabel(to, channel) }))}
          />
          <FilterSelect
            label={t("onlinePayment")}
            value={search.paymentRecovery}
            onChange={(value) => filter({ paymentRecovery: value as OrderListSearch["paymentRecovery"] })}
            options={PAYMENT_RECOVERY_STATES.map((state) => ({ value: state, label: t(`recovery.${state}`) }))}
          />
          <DateRangeFilter
            search={search}
            onChange={(range) => filter({ startDate: formatDateOnly(range?.from), endDate: formatDateOnly(range?.to) })}
          />
          {appFilterable ? (
            <Suspense fallback={<Skeleton className="h-15 w-full" />}>
              <AppListFilter labelled resource="order" value={search.appFilter} onChange={(appFilter) => filter({ appFilter })} />
            </Suspense>
          ) : null}
          <div className="col-span-full flex flex-col justify-end gap-2 sm:flex-row sm:gap-4">
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
        </>
      }
    />
  );
}
