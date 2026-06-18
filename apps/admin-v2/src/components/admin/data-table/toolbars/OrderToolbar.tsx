import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
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

interface OrderToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  selectedCount: number;
  showTrashed: boolean;
  // Status filter
  activeStatus: string | null;
  onStatusFilterChange: (status: string | null) => void;
  // Date range
  dateRange: DateRange | undefined;
  onDateRangeChange: (range: DateRange | undefined) => void;
  // Bulk actions
  onBulkDelete: () => void;
  onBulkShip: () => void;
  isBulkActionBusy?: boolean;
  // Export & refresh
  onExportCSV: () => void;
  // Auto-refresh
  autoRefreshEnabled: boolean;
  onToggleAutoRefresh: () => void;
  countdown: number;
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

export function OrderToolbar({
  searchValue,
  onSearchChange,
  selectedCount,
  showTrashed,
  activeStatus,
  onStatusFilterChange,
  dateRange,
  onDateRangeChange,
  onBulkDelete,
  onBulkShip,
  isBulkActionBusy = false,
  onExportCSV,
  autoRefreshEnabled,
  onToggleAutoRefresh,
  countdown,
}: OrderToolbarProps) {
  const bulkActions: ReactNode =
    selectedCount > 0 ? (
      <div className="flex items-center gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={onBulkDelete}
          disabled={isBulkActionBusy}
          className="h-9 px-3 text-xs"
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          {showTrashed ? "Delete Permanently" : "Move to Trash"} (
          {selectedCount})
        </Button>
        {!showTrashed && (
          <Button
            variant="outline"
            size="sm"
            onClick={onBulkShip}
            disabled={isBulkActionBusy}
            className="h-9 px-3 text-xs"
          >
            <Truck className="mr-1.5 h-3.5 w-3.5" />
            {isBulkActionBusy ? "Shipping..." : `Ship Orders (${selectedCount})`}
          </Button>
        )}
      </div>
    ) : null;

  const actions: ReactNode = (
    <div className="flex items-center gap-2">
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
      {!showTrashed && (
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
    <div className="flex items-center gap-2">
      <LazyDateRangeFilter
        dateRange={dateRange}
        onDateRangeChange={onDateRangeChange}
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
