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
  Trash2,
  Truck,
  Package,
  Download,
  RefreshCw,
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
  onBulkDelete: () => void;
  onBulkShip: () => void;
  isBulkActionBusy?: boolean;
  selectedPaymentRecoveryCount?: number;
  selectedActivePaymentSetupCount?: number;
  selectedActiveRefundCount?: number;
  selectedShipmentLockCount?: number;
  // Export & refresh
  onExportCSV: () => void;
  // Auto-refresh
  autoRefreshEnabled: boolean;
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
      className={`h-9 w-[240px] justify-start text-left text-xs font-normal ${
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
        className="h-9 w-[150px] shrink-0 text-xs sm:w-[170px]"
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
  onBulkDelete,
  onBulkShip,
  isBulkActionBusy = false,
  selectedPaymentRecoveryCount = 0,
  selectedActivePaymentSetupCount = 0,
  selectedActiveRefundCount = 0,
  selectedShipmentLockCount = 0,
  onExportCSV,
  autoRefreshEnabled,
  onToggleAutoRefresh,
  countdown,
  orderActions,
}: OrderToolbarProps) {
  const showBulkDelete = selectedCount > 0 && orderActions.canBulkDeleteOrders;
  const showBulkShip =
    selectedCount > 0 && !showTrashed && orderActions.canBulkShipOrders;
  const bulkDeleteBlockedByRecovery =
    selectedActiveRefundCount > 0 ||
    selectedActivePaymentSetupCount > 0 ||
    selectedShipmentLockCount > 0;
  const bulkShipBlockedByRecovery =
    selectedPaymentRecoveryCount > 0 ||
    selectedActiveRefundCount > 0 ||
    selectedShipmentLockCount > 0;
  const recoveryBlockTitle = selectedActiveRefundCount > 0
    ? "Resolve active refund recovery before changing these orders."
    : selectedActivePaymentSetupCount > 0
      ? "Wait for active hosted payment setup before deleting these orders."
      : selectedShipmentLockCount > 0
        ? "Resolve active shipment recovery before changing these orders."
      : "Resolve hosted payment recovery before creating shipments.";
  const recoveryBlockLabel = selectedActiveRefundCount > 0
    ? `Resolve Refund (${selectedActiveRefundCount})`
    : selectedActivePaymentSetupCount > 0
      ? `Payment Running (${selectedActivePaymentSetupCount})`
      : selectedShipmentLockCount > 0
        ? `Resolve Shipment (${selectedShipmentLockCount})`
      : `Resolve Payment (${selectedPaymentRecoveryCount})`;
  const bulkActions: ReactNode =
    showBulkDelete || showBulkShip ? (
      <div className="flex flex-wrap items-center gap-2">
        {showBulkDelete && (
          <Button
            variant="destructive"
            size="sm"
            onClick={onBulkDelete}
            disabled={isBulkActionBusy || bulkDeleteBlockedByRecovery}
            title={bulkDeleteBlockedByRecovery ? recoveryBlockTitle : undefined}
            className="h-9 px-3 text-xs"
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {bulkDeleteBlockedByRecovery
              ? recoveryBlockLabel
              : `${showTrashed ? "Delete Permanently" : "Move to Trash"} (${selectedCount})`}
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
                ? recoveryBlockTitle
                : undefined
            }
            className="h-9 px-3 text-xs"
          >
            <Truck className="mr-1.5 h-3.5 w-3.5" />
            {bulkShipBlockedByRecovery
              ? recoveryBlockLabel
              : isBulkActionBusy
                ? "Shipping..."
                : `Ship Orders (${selectedCount})`}
          </Button>
        )}
      </div>
    ) : null;

  const actions: ReactNode = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onExportCSV}
        className="h-9 px-3 text-xs"
      >
        <Download className="mr-1.5 h-3.5 w-3.5" />
        Export CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        asChild
        className="h-9 px-3 text-xs"
      >
        <Link
          to="/admin/orders"
          search={showTrashed ? undefined : { trashed: true }}
        >
          {showTrashed ? (
            <>
              <Package className="mr-1.5 h-3.5 w-3.5" /> View Active
            </>
          ) : (
            <>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> View Trash
            </>
          )}
        </Link>
      </Button>
      {!showTrashed && orderActions.canCreateOrders && (
        <Button size="sm" asChild className="h-9 px-3 text-xs">
          <Link to="/admin/orders/new">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Order
          </Link>
        </Button>
      )}
    </div>
  );

  const filters: ReactNode = (
    <div className="flex flex-wrap items-center gap-2">
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
      <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50">
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
            className={`h-3 w-3 ${autoRefreshEnabled ? "animate-spin" : ""}`}
          />
          <span>Auto</span>
          {autoRefreshEnabled && (
            <span className="font-mono font-medium text-primary">
              {countdown}s
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
        searchPlaceholder="Search orders by name, ID, email or phone..."
        selectedCount={selectedCount}
        bulkActions={bulkActions}
        actions={actions}
        filters={filters}
      />

      {/* Status filter pills */}
      {!showTrashed && (
        <div className="flex flex-wrap items-center gap-1.5 pb-2">
          <span className="text-xs font-medium text-muted-foreground mr-1">
            Status:
          </span>
          <Button
            variant={activeStatus === null ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onStatusFilterChange(null)}
            className="h-7 px-2.5 text-xs font-medium"
          >
            All
          </Button>
          {statusFilters.map((filter) => (
            <Button
              key={filter.value}
              variant={
                activeStatus === filter.value ? "secondary" : "ghost"
              }
              size="sm"
              onClick={() => onStatusFilterChange(filter.value)}
              className="h-7 px-2.5 text-xs font-medium"
            >
              {filter.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
