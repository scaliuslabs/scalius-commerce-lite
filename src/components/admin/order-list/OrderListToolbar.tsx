import React from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Checkbox } from "../../ui/checkbox";
import {
  Plus,
  Search,
  Truck,
  Package,
  Trash2,
  Filter,
  X,
  Download,
  RefreshCw,
  CreditCard,
  Banknote,
  Navigation,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DateRange } from "react-day-picker";
import { DateRangePickerWithPresets } from "./DateRangePickerWithPresets";

interface OrderListToolbarProps {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSearchSubmit: (e: React.FormEvent) => void;
  selectedOrdersCount: number;
  onBulkDeleteClick: () => void;
  onBulkShipClick: () => void;
  showTrashed: boolean;
  onToggleTrash: () => void;
  activeStatus: string | null;
  onStatusFilterChange: (status: string | null) => void;
  onExportCSV?: () => void;
  onRefresh?: () => void;
  dateRange: DateRange | undefined;
  onDateRangeChange: (range: DateRange | undefined) => void;
  paymentStatus: string | null;
  onPaymentStatusChange: (status: string | null) => void;
  paymentMethod: string | null;
  onPaymentMethodChange: (method: string | null) => void;
  fulfillmentStatus: string | null;
  onFulfillmentStatusChange: (status: string | null) => void;
}

const statusFilters = [
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "confirmed", label: "Confirmed" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
  { value: "returned", label: "Returned" },
];

export function OrderListToolbar({
  searchQuery,
  onSearchQueryChange,
  onSearchSubmit,
  selectedOrdersCount,
  onBulkDeleteClick,
  onBulkShipClick,
  showTrashed,
  onToggleTrash,
  activeStatus,
  onStatusFilterChange,
  onExportCSV,
  onRefresh,
  dateRange,
  onDateRangeChange,
  paymentStatus,
  onPaymentStatusChange,
  paymentMethod,
  onPaymentMethodChange,
  fulfillmentStatus,
  onFulfillmentStatusChange,
}: OrderListToolbarProps) {
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [localSearch, setLocalSearch] = React.useState(searchQuery);
  const searchTimeoutRef = React.useRef<number | undefined>(undefined);

  // Auto-refresh state - using browser APIs only (Cloudflare Workers compatible)
  const [autoRefreshEnabled, setAutoRefreshEnabled] = React.useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("orderlist-auto-refresh") === "true";
    }
    return false;
  });
  const [countdown, setCountdown] = React.useState(60);
  const refreshIntervalRef = React.useRef<number | undefined>(undefined);
  const countdownIntervalRef = React.useRef<number | undefined>(undefined);

  // Sync local search with prop changes
  React.useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  // Auto-update parent search query after 500ms of inactivity
  React.useEffect(() => {
    if (searchTimeoutRef.current) {
      window.clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = window.setTimeout(() => {
      if (localSearch !== searchQuery) {
        // Just update the search query - the parent will handle the actual search
        onSearchQueryChange(localSearch);
      }
    }, 500);

    return () => {
      if (searchTimeoutRef.current) {
        window.clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [localSearch, searchQuery, onSearchQueryChange]);

  // Auto-refresh logic using browser setInterval (Cloudflare Workers compatible)
  React.useEffect(() => {
    if (autoRefreshEnabled && onRefresh) {
      // Reset countdown
      setCountdown(60);

      // Countdown timer (1 second intervals)
      countdownIntervalRef.current = window.setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            return 60; // Reset to 60 when it reaches 0
          }
          return prev - 1;
        });
      }, 1000);

      // Refresh timer (60 second intervals)
      refreshIntervalRef.current = window.setInterval(() => {
        onRefresh();
      }, 60000);

      return () => {
        if (countdownIntervalRef.current) {
          window.clearInterval(countdownIntervalRef.current);
        }
        if (refreshIntervalRef.current) {
          window.clearInterval(refreshIntervalRef.current);
        }
      };
    } else {
      // Clean up intervals when disabled
      if (countdownIntervalRef.current) {
        window.clearInterval(countdownIntervalRef.current);
      }
      if (refreshIntervalRef.current) {
        window.clearInterval(refreshIntervalRef.current);
      }
    }
  }, [autoRefreshEnabled, onRefresh]);

  // Save preference to localStorage
  const toggleAutoRefresh = () => {
    const newValue = !autoRefreshEnabled;
    setAutoRefreshEnabled(newValue);
    if (typeof window !== "undefined") {
      localStorage.setItem("orderlist-auto-refresh", String(newValue));
    }

    // Optimistic refresh: Trigger immediately when enabling
    if (newValue && onRefresh) {
      onRefresh();
      setCountdown(60); // Reset countdown immediately
    }
  };

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Focus search on "/" key (like GitHub)
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
          e.preventDefault();
          searchInputRef.current?.focus();
        }
      }
      // Clear search on Escape
      if (
        e.key === "Escape" &&
        document.activeElement === searchInputRef.current
      ) {
        setLocalSearch("");
        searchInputRef.current?.blur();
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, []);

  const isStatusActive = (status: string | null) => {
    return activeStatus === status;
  };

  return (
    <>
      <div className="flex items-center justify-between">
        {/* Title and description will be part of the parent CardHeader */}
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50">
            Press{" "}
            <kbd className="px-1.5 py-0.5 bg-background border border-border rounded text-xs font-mono">
              /
            </kbd>{" "}
            to search
          </div>
          {onRefresh && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50">
              <Checkbox
                id="auto-refresh"
                checked={autoRefreshEnabled}
                onCheckedChange={toggleAutoRefresh}
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
          )}
        </div>
        <div className="flex items-center gap-2">
          {onExportCSV && (
            <Button
              variant="outline"
              size="sm"
              onClick={onExportCSV}
              className="group h-9 border-border bg-card/80 px-3 text-xs font-medium shadow-sm backdrop-blur-lg transition-all hover:-translate-y-0.5 hover:border-border hover:bg-card hover:shadow-md active:translate-y-0 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              aria-label="Export orders to CSV file"
            >
              <Download className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-110" />
              Export Page to CSV
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleTrash}
            className="group h-9 border-border bg-card/80 px-3 text-xs font-medium shadow-sm backdrop-blur-lg transition-all hover:-translate-y-0.5 hover:border-border hover:bg-card hover:shadow-md active:translate-y-0 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            aria-label={showTrashed ? "View active orders" : "View trash"}
          >
            {showTrashed ? (
              <>
                <Package className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-110" />
                View Active Orders
              </>
            ) : (
              <>
                <Trash2 className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-110" />
                View Trash
              </>
            )}
          </Button>
          {!showTrashed && (
            <Button
              size="sm"
              asChild
              className="group h-9 px-3 text-xs font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              <a href="/admin/orders/new" aria-label="Create new order">
                <Plus className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-110" />
                Add Order
              </a>
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-center">
        <form onSubmit={onSearchSubmit} className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground transition-colors duration-200 group-hover:text-foreground" />
          <Input
            ref={searchInputRef}
            type="search"
            placeholder="Search orders by name, ID, email or phone... (Press / to focus)"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            className="h-10 pl-9 transition-all duration-200 hover:border-border focus:border-primary focus:ring-2 focus:ring-primary/20 bg-card border-border placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          />
          {localSearch && (
            <button
              type="button"
              onClick={() => setLocalSearch("")}
              className="absolute right-2.5 top-2.5 h-5 w-5 rounded-full hover:bg-muted flex items-center justify-center transition-colors"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </form>
        {selectedOrdersCount > 0 && (
          <div className="flex items-center gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={onBulkDeleteClick}
              className="group h-10 px-3 text-xs font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-110" />
              {showTrashed ? "Delete Permanently" : "Move to Trash"} (
              {selectedOrdersCount})
            </Button>

            {!showTrashed && (
              <Button
                variant="outline"
                size="sm"
                onClick={onBulkShipClick}
                className="group h-10 px-3 text-xs font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:bg-white hover:shadow-md active:translate-y-0 dark:hover:bg-gray-800 dark:hover:border-gray-600"
              >
                <Truck className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-110" />
                Ship Orders ({selectedOrdersCount})
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <div className={cn("flex-shrink-0 grid gap-2", !showTrashed && "mr-2")}>
          <DateRangePickerWithPresets
            date={dateRange}
            setDate={onDateRangeChange}
          />
        </div>

        {!showTrashed && (
          <div className="flex flex-wrap flex-1 gap-3">
            <Select
              value={paymentStatus || "all"}
              onValueChange={(val) => onPaymentStatusChange(val === "all" ? null : val)}
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
              onValueChange={(val) => onPaymentMethodChange(val === "all" ? null : val)}
            >
              <SelectTrigger className="w-[140px] text-xs h-9 bg-background">
                <SelectValue placeholder="Payment Method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any Method</SelectItem>
                <SelectItem value="stripe">Stripe</SelectItem>
                <SelectItem value="sslcommerz">SSLCommerz</SelectItem>
                <SelectItem value="cod">COD</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={fulfillmentStatus || "all"}
              onValueChange={(val) => onFulfillmentStatusChange(val === "all" ? null : val)}
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

      {!showTrashed && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 pt-3 border-t border-border">
          <span className="text-xs font-medium text-muted-foreground mr-2">Status:</span>

          <Button
            variant={isStatusActive(null) ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onStatusFilterChange(null)}
            className="h-8 text-xs font-medium transition-colors"
          >
            All
          </Button>
          {statusFilters.map((filter) => (
            <Button
              key={filter.value}
              variant={isStatusActive(filter.value) ? "secondary" : "ghost"}
              size="sm"
              onClick={() => onStatusFilterChange(filter.value)}
              className="h-8 text-xs font-medium transition-colors"
            >
              {filter.label}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}
