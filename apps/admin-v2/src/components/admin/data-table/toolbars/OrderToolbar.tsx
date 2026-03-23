import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Plus,
  Trash2,
  Truck,
  Package,
  Download,
  RefreshCw,
} from "lucide-react";
import { DataTableToolbar } from "../DataTableToolbar";
import type { DateRange } from "react-day-picker";
import { DateRangePickerWithPresets } from "~/components/admin/order-list/DateRangePickerWithPresets";
import React from "react";

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
  // Payment/fulfillment filters
  paymentStatus: string | null;
  onPaymentStatusChange: (status: string | null) => void;
  paymentMethod: string | null;
  onPaymentMethodChange: (method: string | null) => void;
  fulfillmentStatus: string | null;
  onFulfillmentStatusChange: (status: string | null) => void;
  // Date range
  dateRange: DateRange | undefined;
  onDateRangeChange: (range: DateRange | undefined) => void;
  // Bulk actions
  onBulkDelete: () => void;
  onBulkShip: () => void;
  // Export & refresh
  onExportCSV: () => void;
  onRefresh: () => void;
  // Auto-refresh
  autoRefreshEnabled: boolean;
  onToggleAutoRefresh: () => void;
  countdown: number;
}

export function OrderToolbar({
  searchValue,
  onSearchChange,
  selectedCount,
  showTrashed,
  activeStatus,
  onStatusFilterChange,
  paymentStatus,
  onPaymentStatusChange,
  paymentMethod,
  onPaymentMethodChange,
  fulfillmentStatus,
  onFulfillmentStatusChange,
  dateRange,
  onDateRangeChange,
  onBulkDelete,
  onBulkShip,
  onExportCSV,
  onRefresh,
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
            className="h-9 px-3 text-xs"
          >
            <Truck className="mr-1.5 h-3.5 w-3.5" />
            Ship Orders ({selectedCount})
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
          <span>Auto-refresh</span>
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
    <div className="space-y-4">
      <DataTableToolbar
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        searchPlaceholder="Search orders by name, ID, email or phone..."
        selectedCount={selectedCount}
        bulkActions={bulkActions}
        actions={actions}
        filters={filters}
      />

      {/* Filter row: date range + payment/fulfillment dropdowns */}
      <div className="flex flex-wrap gap-3 pb-2">
        <DateRangePickerWithPresets
          date={dateRange}
          setDate={onDateRangeChange}
        />

        {!showTrashed && (
          <div className="flex flex-wrap flex-1 gap-3">
            <Select
              value={paymentStatus || "all"}
              onValueChange={(val) =>
                onPaymentStatusChange(val === "all" ? null : val)
              }
            >
              <SelectTrigger className="w-[140px] text-xs h-9 bg-background">
                <SelectValue placeholder="Payment Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any Pay Status</SelectItem>
                <SelectItem value="unpaid">Unpaid</SelectItem>
                <SelectItem value="partial">Partial</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="refunded">Refunded</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={paymentMethod || "all"}
              onValueChange={(val) =>
                onPaymentMethodChange(val === "all" ? null : val)
              }
            >
              <SelectTrigger className="w-[140px] text-xs h-9 bg-background">
                <SelectValue placeholder="Payment Method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any Method</SelectItem>
                <SelectItem value="stripe">Stripe</SelectItem>
                <SelectItem value="sslcommerz">SSLCommerz</SelectItem>
                <SelectItem value="cod">COD</SelectItem>
                <SelectItem value="polar">Polar</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={fulfillmentStatus || "all"}
              onValueChange={(val) =>
                onFulfillmentStatusChange(val === "all" ? null : val)
              }
            >
              <SelectTrigger className="w-[140px] text-xs h-9 bg-background">
                <SelectValue placeholder="Fulfillment" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any Fulfillment</SelectItem>
                <SelectItem value="unfulfilled">Unfulfilled</SelectItem>
                <SelectItem value="partial">Partial</SelectItem>
                <SelectItem value="fulfilled">Fulfilled</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Status filter pills */}
      {!showTrashed && (
        <div className="flex flex-wrap items-center gap-1.5 pb-2 border-t border-border pt-3">
          <span className="text-xs font-medium text-muted-foreground mr-2">
            Status:
          </span>
          <Button
            variant={activeStatus === null ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onStatusFilterChange(null)}
            className="h-8 text-xs font-medium transition-colors"
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
              className="h-8 text-xs font-medium transition-colors"
            >
              {filter.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
