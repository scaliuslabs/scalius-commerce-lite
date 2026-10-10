import { lazy, Suspense, useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { ORDER_STATUSES } from "@scalius/shared/order-state";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { useAppPaymentMethodNames } from "~/hooks/use-app-payment-method-names";
import { SearchableSelect, type SearchableSelectOption } from "~/components/ui/searchable-select";
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

/** Filter fields load when the toolbar opens its filter panel. */
export function OrderListFilters({ search, onChange, appFilterable }: {
  search: OrderListSearch;
  onChange: (updates: Partial<OrderListSearch>) => void;
  appFilterable: boolean;
}) {
  const t = useMessages(orderListMessages);
  const to = useMessages(orderMessages);
  const filter = (patch: Partial<OrderListSearch>) => onChange({ ...patch, page: 1 });
  return (
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
  );
}
