import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Calendar as CalendarIcon,
  Plus,
  Archive,
  Truck,
  Package,
  Download,
  ListFilter,
  RefreshCw,
  X,
} from "lucide-react";
import { DataTableToolbar } from "../DataTableToolbar";
import type { DateRange } from "react-day-picker";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";

const DateRangePickerWithPresets = lazy(() =>
  import("~/components/admin/order-list/DateRangePickerWithPresets").then(
    (module) => ({ default: module.DateRangePickerWithPresets }),
  ),
);

const statusFilters = [
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "confirmed", label: "Confirmed" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "refunded", label: "Refunded" },
  { value: "returned", label: "Returned" },
  { value: "partially_refunded", label: "Partially Refunded" },
  { value: "incomplete", label: "Incomplete" },
];

const orderViews = [
  { value: null, label: "All" },
  { value: "open", label: "Open" },
  { value: "in_transit", label: "In transit" },
  { value: "delivered", label: "Delivered" },
  { value: "closed", label: "Closed" },
] as const;

type OrderStatusGroup = Exclude<(typeof orderViews)[number]["value"], null>;

const ALL_FILTER_VALUE = "all";

const paymentStatusFilters = [
  { value: "unpaid", label: "Unpaid" },
  { value: "partial", label: "Partial" },
  { value: "paid", label: "Paid" },
  { value: "refunded", label: "Refunded" },
  { value: "failed", label: "Failed" },
];

const paymentMethodFilters = [
  { value: "cod", label: "COD" },
  { value: "stripe", label: "Stripe" },
  { value: "sslcommerz", label: "SSLCommerz" },
  { value: "polar", label: "Polar" },
];

const fulfillmentStatusFilters = [
  { value: "pending", label: "Pending fulfillment" },
  { value: "partial", label: "Partially fulfilled" },
  { value: "complete", label: "Fulfilled" },
];

const paymentRecoveryFilters = [
  { value: "recoverable", label: "Any recovery" },
  { value: "needs_attention", label: "Needs attention" },
  { value: "processing", label: "Processing" },
  { value: "awaiting_payment", label: "Awaiting payment" },
];

interface OrderToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  selectedCount: number;
  showTrashed: boolean;
  // Status filter
  activeStatus: string | null;
  onStatusFilterChange: (status: string | null) => void;
  activeStatusGroup: OrderStatusGroup | null;
  onStatusGroupChange: (status: OrderStatusGroup | null) => void;
  activePaymentStatus: string | null;
  onPaymentStatusFilterChange: (status: string | null) => void;
  activePaymentMethod: string | null;
  onPaymentMethodFilterChange: (method: string | null) => void;
  activeFulfillmentStatus: string | null;
  onFulfillmentStatusFilterChange: (status: string | null) => void;
  activePaymentRecovery: string | null;
  onPaymentRecoveryFilterChange: (state: string | null) => void;
  // Date range
  dateRange: DateRange | undefined;
  onDateRangeChange: (range: DateRange | undefined) => void;
  // Bulk actions
  onBulkArchive: () => void;
  onBulkShip: () => void;
  isBulkActionBusy?: boolean;
  selectedPaymentRecoveryCount?: number;
  selectedActivePaymentSetupCount?: number;
  selectedActiveRefundCount?: number;
  selectedShipmentLockCount?: number;
  selectedArchiveBlockedCount?: number;
  // Export & refresh
  onExportCSV: () => void;
  exportLabel: string;
  // Auto-refresh
  autoRefreshEnabled: boolean;
  autoRefreshPauseReason: string | null;
  onToggleAutoRefresh: () => void;
  countdown: number;
  orderActions: OrderActionPermissions;
}

function formatRangeDate(date: Date) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getDateRangeLabel(dateRange: DateRange | undefined) {
  if (!dateRange?.from) return "Pick a date range";
  if (!dateRange.to) return formatRangeDate(dateRange.from);
  return `${formatRangeDate(dateRange.from)} - ${formatRangeDate(dateRange.to)}`;
}

function DateRangeButton({
  dateRange,
  onClick,
  disabled,
}: {
  dateRange: DateRange | undefined;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      id="date"
      variant="outline"
      size="sm"
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-11 w-full justify-start text-left text-xs font-normal sm:h-9 ${
        !dateRange ? "text-muted-foreground" : ""
      }`}
      aria-busy={disabled ? "true" : undefined}
    >
      <CalendarIcon className="mr-2 h-3.5 w-3.5" />
      <span className="truncate" suppressHydrationWarning>
        {getDateRangeLabel(dateRange)}
      </span>
    </Button>
  );
}

function LazyDateRangeFilter({
  dateRange,
  onDateRangeChange,
}: {
  dateRange: DateRange | undefined;
  onDateRangeChange: (range: DateRange | undefined) => void;
}) {
  const [shouldLoadPicker, setShouldLoadPicker] = useState(false);

  if (!shouldLoadPicker) {
    return (
      <DateRangeButton
        dateRange={dateRange}
        onClick={() => setShouldLoadPicker(true)}
      />
    );
  }

  return (
    <Suspense
      fallback={<DateRangeButton dateRange={dateRange} disabled />}
    >
      <DateRangePickerWithPresets
        date={dateRange}
        setDate={onDateRangeChange}
        initialOpen
      />
    </Suspense>
  );
}

function OrderFilterSelect({
  value,
  placeholder,
  options,
  ariaLabel,
  onChange,
}: {
  value: string | null;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <Select
      value={value ?? ALL_FILTER_VALUE}
      onValueChange={(nextValue) =>
        onChange(nextValue === ALL_FILTER_VALUE ? null : nextValue)
      }
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className="h-11 w-full text-xs sm:h-9"
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="rounded-xl bg-background">
        <SelectItem value={ALL_FILTER_VALUE}>{placeholder}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function OrderToolbar({
  searchValue,
  onSearchChange,
  selectedCount,
  showTrashed,
  activeStatus,
  onStatusFilterChange,
  activeStatusGroup,
  onStatusGroupChange,
  activePaymentStatus,
  onPaymentStatusFilterChange,
  activePaymentMethod,
  onPaymentMethodFilterChange,
  activeFulfillmentStatus,
  onFulfillmentStatusFilterChange,
  activePaymentRecovery,
  onPaymentRecoveryFilterChange,
  dateRange,
  onDateRangeChange,
  onBulkArchive,
  onBulkShip,
  isBulkActionBusy = false,
  selectedPaymentRecoveryCount = 0,
  selectedActivePaymentSetupCount = 0,
  selectedActiveRefundCount = 0,
  selectedShipmentLockCount = 0,
  selectedArchiveBlockedCount = 0,
  onExportCSV,
  exportLabel,
  autoRefreshEnabled,
  autoRefreshPauseReason,
  onToggleAutoRefresh,
  countdown,
  orderActions,
}: OrderToolbarProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeAdvancedFilterCount = [
    dateRange?.from,
    activePaymentStatus,
    activePaymentMethod,
    activePaymentRecovery,
    activeFulfillmentStatus,
  ].filter(Boolean).length;
  const showBulkArchive = selectedCount > 0 && !showTrashed && orderActions.canBulkDeleteOrders;
  const showBulkShip =
    selectedCount > 0 && !showTrashed && orderActions.canBulkShipOrders;
  const bulkArchiveBlocked =
    selectedArchiveBlockedCount > 0 ||
    selectedActiveRefundCount > 0 ||
    selectedActivePaymentSetupCount > 0 ||
    selectedShipmentLockCount > 0;
  const bulkShipBlockedByRecovery =
    selectedPaymentRecoveryCount > 0 ||
    selectedActiveRefundCount > 0 ||
    selectedShipmentLockCount > 0;
  const archiveBlockTitle = selectedArchiveBlockedCount > 0
    ? "Complete, cancel, return, or fully refund selected orders before archiving."
    : selectedActiveRefundCount > 0
    ? "Resolve active refund recovery before archiving these orders."
    : selectedActivePaymentSetupCount > 0
      ? "Wait for active hosted payment setup before archiving these orders."
      : selectedShipmentLockCount > 0
        ? "Resolve active shipment recovery before archiving these orders."
        : undefined;
  const archiveBlockLabel = selectedArchiveBlockedCount > 0
    ? `Finish orders (${selectedArchiveBlockedCount})`
    : selectedActiveRefundCount > 0
    ? `Resolve refund (${selectedActiveRefundCount})`
    : selectedActivePaymentSetupCount > 0
      ? `Payment running (${selectedActivePaymentSetupCount})`
      : selectedShipmentLockCount > 0
        ? `Resolve shipment (${selectedShipmentLockCount})`
        : "Archive";
  const shipBlockTitle = selectedActiveRefundCount > 0
    ? "Resolve active refund recovery before creating shipments."
    : selectedShipmentLockCount > 0
      ? "Resolve active shipment recovery before creating shipments."
      : "Resolve hosted payment recovery before creating shipments.";
  const shipBlockLabel = selectedActiveRefundCount > 0
    ? `Resolve refund (${selectedActiveRefundCount})`
    : selectedShipmentLockCount > 0
      ? `Resolve shipment (${selectedShipmentLockCount})`
      : `Resolve payment (${selectedPaymentRecoveryCount})`;
  const bulkActions: ReactNode =
    showBulkArchive || showBulkShip ? (
      <div className="flex flex-wrap items-center gap-2">
        {showBulkArchive && (
          <Button
            variant="outline"
            size="sm"
            onClick={onBulkArchive}
            disabled={isBulkActionBusy || bulkArchiveBlocked}
            title={bulkArchiveBlocked ? archiveBlockTitle : undefined}
            className="h-11 px-3 text-xs sm:h-9"
          >
            <Archive className="mr-1.5 h-3.5 w-3.5" />
            {bulkArchiveBlocked
              ? archiveBlockLabel
              : `Archive (${selectedCount})`}
          </Button>
        )}
        {showBulkShip && (
          <Button
            variant="outline"
            size="sm"
            onClick={onBulkShip}
            disabled={isBulkActionBusy || bulkShipBlockedByRecovery}
            title={
              bulkShipBlockedByRecovery
                ? shipBlockTitle
                : undefined
            }
            className="h-11 px-3 text-xs sm:h-9"
          >
            <Truck className="mr-1.5 h-3.5 w-3.5" />
            {bulkShipBlockedByRecovery
              ? shipBlockLabel
              : isBulkActionBusy
                ? "Shipping..."
                : `Ship orders (${selectedCount})`}
          </Button>
        )}
      </div>
    ) : null;

  const actions: ReactNode = (
    <div className="flex w-full flex-nowrap items-center gap-2 overflow-x-auto scrollbar-hide sm:w-auto sm:flex-wrap sm:overflow-visible">
      <Button
        variant="outline"
        size="sm"
        onClick={onExportCSV}
      className="h-11 px-3 text-xs sm:h-9"
      >
        <Download className="mr-1.5 h-3.5 w-3.5" />
        {exportLabel}
      </Button>
      <Button
        variant="outline"
        size="sm"
        asChild
        className="h-11 px-3 text-xs sm:h-9"
      >
        <Link
          to="/admin/orders"
          search={showTrashed ? undefined : { archived: true }}
        >
          {showTrashed ? (
            <>
              <Package className="mr-1.5 h-3.5 w-3.5" /> View active
            </>
          ) : (
            <>
              <Archive className="mr-1.5 h-3.5 w-3.5" /> Archived
            </>
          )}
        </Link>
      </Button>
      {!showTrashed && orderActions.canCreateOrders && (
        <Button size="sm" asChild className="h-11 px-3 text-xs sm:h-9">
          <Link to="/admin/orders/new">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add order
          </Link>
        </Button>
      )}
    </div>
  );

  const filters: ReactNode = (
    <div className="flex flex-nowrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 shrink-0 gap-1.5 px-3 text-xs sm:h-9"
        aria-expanded={filtersOpen}
        aria-controls="order-advanced-filters"
        onClick={() => setFiltersOpen((open) => !open)}
      >
        <ListFilter className="h-3.5 w-3.5" />
        Filters
        {activeAdvancedFilterCount > 0 ? (
          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
            {activeAdvancedFilterCount}
          </span>
        ) : null}
      </Button>
      <div
        className="flex min-h-11 items-center gap-2 rounded-md border border-border/50 bg-muted/50 px-2 py-1 text-xs text-muted-foreground sm:min-h-9"
        title={autoRefreshPauseReason ?? undefined}
      >
        <Checkbox
          id="auto-refresh"
          checked={autoRefreshEnabled}
          onCheckedChange={onToggleAutoRefresh}
          className="h-3.5 w-3.5"
        />
        <label
          htmlFor="auto-refresh"
          className="cursor-pointer select-none flex items-center gap-1.5"
        >
          <RefreshCw
            className={`h-3 w-3 ${autoRefreshEnabled && !autoRefreshPauseReason ? "animate-spin" : ""}`}
          />
          <span>Auto-refresh</span>
          {autoRefreshEnabled && (
            <span
              aria-live="polite"
              className="font-mono font-medium text-primary"
            >
              {autoRefreshPauseReason ? "Paused" : `${countdown}s`}
            </span>
          )}
        </label>
      </div>
    </div>
  );

  return (
    <div className="space-y-1.5">
      <DataTableToolbar
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        searchPlaceholder="Search orders…"
        selectedCount={selectedCount}
        bulkActions={bulkActions}
        actions={actions}
        filters={filters}
      />

      {filtersOpen ? (
        <div
          id="order-advanced-filters"
          className="rounded-lg border bg-muted/15 p-3"
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <LazyDateRangeFilter
              dateRange={dateRange}
              onDateRangeChange={onDateRangeChange}
            />
            <OrderFilterSelect
              value={activePaymentStatus}
              placeholder="Any payment"
              options={paymentStatusFilters}
              ariaLabel="Filter by payment status"
              onChange={onPaymentStatusFilterChange}
            />
            <OrderFilterSelect
              value={activePaymentMethod}
              placeholder="Any method"
              options={paymentMethodFilters}
              ariaLabel="Filter by payment method"
              onChange={onPaymentMethodFilterChange}
            />
            <OrderFilterSelect
              value={activePaymentRecovery}
              placeholder="Payment recovery"
              options={paymentRecoveryFilters}
              ariaLabel="Filter by payment recovery"
              onChange={onPaymentRecoveryFilterChange}
            />
            <OrderFilterSelect
              value={activeFulfillmentStatus}
              placeholder="Any fulfillment"
              options={fulfillmentStatusFilters}
              ariaLabel="Filter by fulfillment status"
              onChange={onFulfillmentStatusFilterChange}
            />
          </div>
          {activeAdvancedFilterCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 h-11 px-2 text-xs text-muted-foreground sm:h-8"
              onClick={() => {
                onDateRangeChange(undefined);
                onPaymentStatusFilterChange(null);
                onPaymentMethodFilterChange(null);
                onPaymentRecoveryFilterChange(null);
                onFulfillmentStatusFilterChange(null);
              }}
            >
              <X className="mr-1.5 h-3.5 w-3.5" />
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Workflow views keep the lifecycle scannable; exact status remains one click away. */}
      {!showTrashed && (
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-2 sm:flex-row sm:items-center sm:justify-between">
          <div
            className="grid w-full grid-cols-6 gap-1 rounded-md bg-muted/60 p-1 sm:w-auto sm:grid-cols-5 sm:gap-0"
            role="group"
            aria-label="Order views"
          >
            {orderViews.map((view, index) => {
              const selected = activeStatus === null && activeStatusGroup === view.value;
              return (
                <Button
                  key={view.label}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={selected}
                  onClick={() => onStatusGroupChange(view.value)}
                  className={`h-11 min-w-0 rounded-sm px-1.5 text-xs font-medium sm:col-span-1 sm:h-8 sm:px-3 ${
                    index >= 3 ? "col-span-3" : "col-span-2"
                  } ${
                    selected ? "bg-background text-foreground shadow-sm hover:bg-background" : "text-muted-foreground"
                  }`}
                >
                  <span className="truncate">{view.label}</span>
                </Button>
              );
            })}
          </div>
          <div className="w-full sm:w-48">
            <OrderFilterSelect
              value={activeStatus}
              placeholder="Any order status"
              options={statusFilters}
              ariaLabel="Filter by exact order status"
              onChange={onStatusFilterChange}
            />
          </div>
        </div>
      )}
    </div>
  );
}
