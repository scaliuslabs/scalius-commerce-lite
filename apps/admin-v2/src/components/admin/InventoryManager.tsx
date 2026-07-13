// src/components/admin/InventoryManager.tsx
// Rebuilt Inventory Management Dashboard (Premium UI/UX).
// Uses TanStack Query for data fetching and shadcn Dialog for the adjust modal.

import { Link } from "@tanstack/react-router";
import { useState, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Package, ArrowUpDown, History, AlertTriangle, Search, RefreshCw, Plus, Minus, X, ArrowUp, ArrowDown, Check, Download, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@scalius/shared/utils";
import { AdminListPagination } from "@/components/admin/shared/AdminListPagination";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { inventoryQueryOptions } from "@/lib/api-query-options/inventory";
import {
  adjustInventory,
  acknowledgeInventoryAlert,
  stockSet,
  type InventoryAlert,
  type InventoryMovement,
  type InventoryMovementPageInfo,
  type InventoryPagination,
  type InventoryStats,
  type InventoryVariant,
  type InventoryAdjustmentReason,
} from "@/lib/api-functions/inventory";
import { useDebounce } from "@/hooks/use-debounce";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import type { InventoryWorkspaceSection } from "./inventory-workspace";

// ---------- Types ----------

type StockFilter = "all" | "low" | "out" | "reserved";
type AlertStatusFilter = "active" | "acknowledged" | "resolved" | "all";
type SortField = "productName" | "sku" | "available";
type SortOrder = "asc" | "desc";
type SortSelection = `${SortField}:${SortOrder}`;
type MovementTypeFilter = "all" | "reserved" | "deducted" | "released" | "adjusted" | "restored" | "preorder_reserved" | "preorder_deducted";
type AdjustmentMode = "relative" | "stocktake";

function createInventoryOperationKey(): string {
  return `invop_${crypto.randomUUID()}`;
}

// ---------- Helper Functions ----------

function getStockBadge(available: number, threshold: number | null) {
  if (available <= 0) return { label: "Out of Stock", variant: "destructive" as const, className: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400 border-red-200 dark:border-red-900" };
  if (threshold && available <= threshold) return { label: "Low Stock", variant: "default" as const, className: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400 border-amber-200 dark:border-amber-900 hover:bg-amber-50" };
  return { label: "In Stock", variant: "secondary" as const, className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900" };
}

function getMovementBadge(type: string) {
  const map: Record<string, { label: string; className: string }> = {
    reserved: { label: "Reserved", className: "bg-blue-50 text-blue-700 border-blue-200" },
    deducted: { label: "Deducted", className: "bg-red-50 text-red-700 border-red-200" },
    released: { label: "Released", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    adjusted: { label: "Adjusted", className: "bg-amber-50 text-amber-700 border-amber-200" },
    preorder_reserved: { label: "Pre-order", className: "bg-purple-50 text-purple-700 border-purple-200" },
    preorder_deducted: { label: "Pre-order Deducted", className: "bg-purple-50 text-purple-700 border-purple-200" },
    restored: { label: "Restored", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  };
  return map[type] ?? { label: type, className: "bg-gray-50 text-gray-700 border-gray-200" };
}

type MovementCounterChange = {
  label: string;
  previous: number;
  next: number;
  delta: number;
};

function getMovementCounterChanges(movement: InventoryMovement): MovementCounterChange[] {
  if (movement.ledgerVersion !== 2) {
    return [{
      label: "Stock",
      previous: movement.previousStock,
      next: movement.newStock,
      delta: movement.newStock - movement.previousStock,
    }];
  }

  const changes: MovementCounterChange[] = [];
  if (movement.stockDelta) {
    changes.push({
      label: "On hand",
      previous: movement.previousStock,
      next: movement.newStock,
      delta: movement.stockDelta,
    });
  }
  if (
    movement.reservedStockDelta &&
    movement.previousReservedStock != null &&
    movement.newReservedStock != null
  ) {
    changes.push({
      label: "Reserved",
      previous: movement.previousReservedStock,
      next: movement.newReservedStock,
      delta: movement.reservedStockDelta,
    });
  }
  if (
    movement.preorderStockDelta &&
    movement.previousPreorderStock != null &&
    movement.newPreorderStock != null
  ) {
    changes.push({
      label: "Preorder",
      previous: movement.previousPreorderStock,
      next: movement.newPreorderStock,
      delta: movement.preorderStockDelta,
    });
  }

  return changes.length > 0 ? changes : [{
    label: "Counters",
    previous: movement.previousStock,
    next: movement.newStock,
    delta: 0,
  }];
}

function movementDate(dateValue: string | number): Date {
  return new Date(
    typeof dateValue === "number" && dateValue < 10_000_000_000
      ? dateValue * 1000
      : dateValue,
  );
}

function formatMovementTimestamp(dateValue: string | number): string {
  const date = movementDate(dateValue);
  if (!Number.isFinite(date.getTime())) return "Invalid timestamp";
  return new Intl.DateTimeFormat("en-BD", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Dhaka",
  }).format(date);
}

function timeAgo(dateValue: string | number) {
  const date = movementDate(dateValue);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US");
}

function InventorySummaryStrip({ stats }: { stats: InventoryStats }) {
  const items = [
    { label: "SKUs", value: stats.totalVariants, icon: Package, detail: "Sellable inventory identities" },
    { label: "On hand", value: stats.totalOnHand, icon: Package, detail: "Physical stock recorded across tracked SKUs" },
    { label: "Committed", value: stats.totalReserved, icon: History, detail: "Units reserved by open orders" },
    { label: "Available", value: stats.totalAvailable, icon: Package, detail: "On hand minus committed units" },
    { label: "Low stock", value: stats.lowStockCount, icon: AlertTriangle, detail: "SKUs at or below their saved alert threshold" },
    { label: "Sold out", value: stats.outOfStockCount, icon: AlertTriangle, detail: "SKUs with no buyer-available units" },
  ] as const;

  return (
    <div className="mt-2 grid grid-cols-3 gap-px overflow-hidden rounded-md border bg-border lg:grid-cols-6">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Tooltip key={item.label}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 items-center gap-2 bg-background px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-label={`${item.label}: ${item.value}. ${item.detail}`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-xs text-muted-foreground">{item.label}</p>
                  <p className="text-sm font-semibold tabular-nums text-foreground">{item.value}</p>
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64">{item.detail}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ---------- Main Component ----------

interface InventoryManagerProps {
  section: InventoryWorkspaceSection;
  onSectionChange: (section: InventoryWorkspaceSection) => void;
}

export function InventoryManager({
  section: activeTab,
  onSectionChange,
}: InventoryManagerProps) {
  const { inventory: inventoryActions } = useCatalogActionPermissions();
  // Local UI state
  const [requestedPage, setRequestedPage] = useState(1);
  const [requestedLimit, setRequestedLimit] = useState(50);
  const [movementsRequestedLimit, setMovementsRequestedLimit] = useState(50);
  const [movementCursorHistory, setMovementCursorHistory] = useState<string[]>([""]);
  const [movementLocalSearch, setMovementLocalSearch] = useState("");
  const [movementOrderId, setMovementOrderId] = useState("");
  const [movementStartDate, setMovementStartDate] = useState("");
  const [movementEndDate, setMovementEndDate] = useState("");
  const [movementType, setMovementType] = useState<MovementTypeFilter>("all");
  const [alertsRequestedPage, setAlertsRequestedPage] = useState(1);
  const [alertsRequestedLimit, setAlertsRequestedLimit] = useState(20);
  const [alertLocalSearch, setAlertLocalSearch] = useState("");
  const [alertStatus, setAlertStatus] = useState<AlertStatusFilter>("active");
  const [localSearch, setLocalSearch] = useState("");
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [sort, setSort] = useState<{ field: SortField; order: SortOrder }>({ field: "available", order: "asc" });
  const [adjustingVariant, setAdjustingVariant] = useState<InventoryVariant | null>(null);

  const queryClient = useQueryClient();
  const search = useDebounce(localSearch, 300);
  const movementSearch = useDebounce(movementLocalSearch, 300);
  const debouncedMovementOrderId = useDebounce(movementOrderId, 300);
  const alertSearch = useDebounce(alertLocalSearch, 300);

  // TanStack Query — variants
  const variantsQuery = useQuery({
    ...inventoryQueryOptions({
      section: "variants",
      search: search || undefined,
      status: stockFilter === "all" ? undefined : stockFilter,
      page: requestedPage,
      limit: requestedLimit,
      sort: sort.field,
      order: sort.order,
    }),
    placeholderData: keepPreviousData,
    enabled: activeTab === "variants",
  });

  // TanStack Query — movements
  const movementsQuery = useQuery({
    ...inventoryQueryOptions({
      section: "movements",
      search: movementSearch || undefined,
      movementType,
      movementOrderId: debouncedMovementOrderId.trim() || undefined,
      movementStartDate: movementStartDate || undefined,
      movementEndDate: movementEndDate || undefined,
      movementCursor: movementCursorHistory.at(-1) || undefined,
      limit: movementsRequestedLimit,
    }),
    placeholderData: keepPreviousData,
    enabled: activeTab === "movements",
  });

  const movementHealthQuery = useQuery({
    ...inventoryQueryOptions({
      section: "movements",
      movementHealthOnly: true,
      page: 1,
      limit: 1,
    }),
    staleTime: 5 * 60 * 1000,
    enabled: activeTab === "movements",
  });

  const alertsQuery = useQuery({
    ...inventoryQueryOptions({
      section: "alerts",
      search: alertSearch || undefined,
      alertStatus,
      page: alertsRequestedPage,
      limit: alertsRequestedLimit,
    }),
    placeholderData: keepPreviousData,
    enabled: activeTab === "alerts",
  });

  const acknowledgeAlertMutation = useMutation({
    mutationFn: (variantId: string) => acknowledgeInventoryAlert({ data: { variantId } }),
    onSuccess: async () => {
      toast.success("Alert acknowledged");
      await queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not acknowledge alert");
    },
  });

  // Extract typed data from query results
  const variantsData = useMemo(() => {
    const raw = variantsQuery.data;
    if (!raw) return { variants: [] as InventoryVariant[], stats: null as InventoryStats | null, pagination: null as InventoryPagination | null };
    return {
      variants: raw.variants || [],
      stats: raw.stats || null,
      pagination: raw.pagination || null,
    };
  }, [variantsQuery.data]);

  const movementsData = useMemo(() => {
    const raw = movementsQuery.data;
    if (!raw) return {
      movements: [] as InventoryMovement[],
      pageInfo: null as InventoryMovementPageInfo | null,
    };
    return {
      movements: raw.movements || [],
      pageInfo: raw.pageInfo || null,
    };
  }, [movementsQuery.data]);

  const alertsData = useMemo(() => {
    const raw = alertsQuery.data;
    if (!raw) return {
      alerts: [] as InventoryAlert[],
      pagination: null as InventoryPagination | null,
    };
    return {
      alerts: raw.alerts || [],
      pagination: raw.pagination || null,
    };
  }, [alertsQuery.data]);

  const { variants, stats, pagination } = variantsData;
  const { movements, pageInfo: movementsPageInfo } = movementsData;
  const ledgerHealth = movementHealthQuery.data?.ledgerHealth || null;
  const { alerts, pagination: alertsPagination } = alertsData;

  const loading = activeTab === "variants"
    ? variantsQuery.isFetching
    : activeTab === "alerts"
      ? alertsQuery.isFetching
      : movementsQuery.isFetching;
  const isInitialLoad = activeTab === "variants" ? variantsQuery.isLoading : movementsQuery.isLoading;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["inventory"] });
  }, [queryClient]);

  const clearFilters = useCallback(() => {
    setLocalSearch("");
    setStockFilter("all");
    setRequestedPage(1);
  }, []);

  const handleSort = useCallback((field: SortField) => {
    setRequestedPage(1);
    setSort(prev => ({
      field,
      order: prev.field === field && prev.order === "asc" ? "desc" : "asc"
    }));
  }, []);

  const handleSortSelection = useCallback((value: SortSelection) => {
    const [field, order] = value.split(":") as [SortField, SortOrder];
    setRequestedPage(1);
    setSort({ field, order });
  }, []);

  const hasActiveFilters = localSearch.trim() || stockFilter !== "all";
  const hasMovementFilters = Boolean(
    movementLocalSearch.trim()
    || movementOrderId.trim()
    || movementStartDate
    || movementEndDate
    || movementType !== "all",
  );

  const movementExportHref = useMemo(() => {
    const params = new URLSearchParams({
      section: "movements",
      format: "csv",
      maxRows: "5000",
      movementType,
    });
    if (movementSearch) params.set("search", movementSearch);
    if (debouncedMovementOrderId.trim()) params.set("movementOrderId", debouncedMovementOrderId.trim());
    if (movementStartDate) params.set("movementStartDate", movementStartDate);
    if (movementEndDate) params.set("movementEndDate", movementEndDate);
    return `/api/v1/admin/inventory?${params.toString()}`;
  }, [debouncedMovementOrderId, movementEndDate, movementSearch, movementStartDate, movementType]);

  const reviewAlertSku = useCallback((alert: InventoryAlert) => {
    setLocalSearch(alert.variantSku || alert.variantId);
    setStockFilter("all");
    setRequestedPage(1);
    onSectionChange("variants");
  }, [onSectionChange]);

  return (
    <Card className="border-none shadow-none bg-transparent sm:bg-card">
      <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2 border-b">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold tracking-tight">Inventory</CardTitle>
            <CardDescription className="mt-0 text-xs text-muted-foreground">
              Monitor stock levels, adjust quantities, and track movements across {stats?.totalVariants || 0} variants.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>

        {stats ? <InventorySummaryStrip stats={stats} /> : null}
      </CardHeader>

      <CardContent className="p-0">
        {/* Tabs */}
        <div className="border-b px-2 sm:px-3">
          <nav className="flex gap-4" role="tablist" aria-label="Inventory views">
            <button
              id="inventory-variants-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "variants"}
              aria-controls="inventory-variants-panel"
              onClick={() => onSectionChange("variants")}
              className={cn("flex items-center gap-2 py-2 text-sm font-medium border-b-2 transition-colors", activeTab === "variants" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              <Package className="h-3.5 w-3.5" /> All Variants
            </button>
            <button
              id="inventory-alerts-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "alerts"}
              aria-controls="inventory-alerts-panel"
              onClick={() => onSectionChange("alerts")}
              className={cn("flex items-center gap-2 py-2 text-sm font-medium border-b-2 transition-colors", activeTab === "alerts" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              <AlertTriangle className="h-3.5 w-3.5" /> Low-stock alerts
            </button>
            <button
              id="inventory-movements-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "movements"}
              aria-controls="inventory-movements-panel"
              onClick={() => onSectionChange("movements")}
              className={cn("flex items-center gap-2 py-2 text-sm font-medium border-b-2 transition-colors", activeTab === "movements" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              <History className="h-3.5 w-3.5" /> Recent Movements
            </button>
          </nav>
        </div>

        {/* Variants Tab */}
        {activeTab === "variants" && (
          <div
            id="inventory-variants-panel"
            role="tabpanel"
            aria-labelledby="inventory-variants-tab"
            aria-busy={variantsQuery.isFetching}
            className="p-2 sm:p-3 space-y-2"
          >
            {/* Toolbar */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_140px] gap-1.5 sm:flex sm:w-auto sm:flex-1 sm:items-center">
                <div className="relative min-w-0 sm:max-w-xs sm:flex-1">
                  <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search name or SKU..."
                    aria-label="Search inventory by product name or SKU"
                    value={localSearch}
                    onChange={(e) => {
                      setLocalSearch(e.target.value);
                      setRequestedPage(1);
                    }}
                    className="h-8 w-full pl-7 text-sm"
                  />
                </div>
                <Select value={stockFilter} onValueChange={(v: StockFilter) => {
                  setStockFilter(v);
                  setRequestedPage(1);
                }}>
                  <SelectTrigger className="h-8 w-[140px] text-sm">
                    <SelectValue placeholder="Status: All" />
                  </SelectTrigger>
                  <SelectContent className="text-xs">
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="low">Low Stock</SelectItem>
                    <SelectItem value="out">Out of Stock</SelectItem>
                    <SelectItem value="reserved">Has Reservations</SelectItem>
                  </SelectContent>
                </Select>
                {hasActiveFilters && (
                  <Button variant="ghost" size="sm" className="col-span-2 h-8 justify-self-start px-1.5 text-sm text-muted-foreground" onClick={clearFilters}>
                    <X className="h-3.5 w-3.5 mr-1" /> Clear
                  </Button>
                )}
              </div>
            </div>

            <div className="flex min-w-0 items-center gap-2 md:hidden">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">Sort</span>
              <Select
                value={`${sort.field}:${sort.order}` satisfies SortSelection}
                onValueChange={(value) => handleSortSelection(value as SortSelection)}
              >
                <SelectTrigger className="h-8 min-w-0 flex-1 text-sm" aria-label="Sort inventory variants">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="available:asc">Available: low to high</SelectItem>
                  <SelectItem value="available:desc">Available: high to low</SelectItem>
                  <SelectItem value="productName:asc">Product: A to Z</SelectItem>
                  <SelectItem value="productName:desc">Product: Z to A</SelectItem>
                  <SelectItem value="sku:asc">SKU: A to Z</SelectItem>
                  <SelectItem value="sku:desc">SKU: Z to A</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <InventoryVariantMobileList
              variants={variants}
              isError={variantsQuery.isError}
              isInitialLoad={isInitialLoad}
              isRefreshing={loading}
              hasActiveFilters={Boolean(hasActiveFilters)}
              canAdjust={inventoryActions.canAdjustStock}
              onAdjust={setAdjustingVariant}
              onRetry={() => void variantsQuery.refetch()}
            />

            {/* Table */}
            <div data-inventory-layout="desktop" className="relative hidden overflow-hidden rounded-md border md:block">
              {loading && variants.length > 0 && (
                <div aria-hidden="true" className="absolute inset-0 bg-background/50 backdrop-blur-[1px] z-10" />
              )}
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50 border-b">
                    <TableHead className="py-2 text-xs h-8 pl-3 w-[250px]">
                      <Button variant="ghost" className="px-0 hover:bg-transparent -ml-1 h-6 text-xs font-medium" onClick={() => handleSort("productName")}>
                        Product {sort.field === "productName" && (sort.order === "asc" ? <ArrowUp className="ml-1 h-3 w-3 inline" /> : <ArrowDown className="ml-1 h-3 w-3 inline" />)}
                      </Button>
                    </TableHead>
                    <TableHead className="py-2 text-xs h-8">
                      <Button variant="ghost" className="px-0 hover:bg-transparent -ml-1 h-6 text-xs font-medium" onClick={() => handleSort("sku")}>
                        SKU {sort.field === "sku" && (sort.order === "asc" ? <ArrowUp className="ml-1 h-3 w-3 inline" /> : <ArrowDown className="ml-1 h-3 w-3 inline" />)}
                      </Button>
                    </TableHead>
                    <TableHead className="py-2 text-xs font-medium h-8 w-[150px]">Variant Details</TableHead>
                    <TableHead className="text-right py-2 text-xs font-medium h-8 w-[80px]">On Hand</TableHead>
                    <TableHead className="text-right py-2 text-xs font-medium h-8 w-[80px]">Reserved</TableHead>
                    <TableHead className="text-right py-2 text-xs h-8 w-[80px]">
                      <Button variant="ghost" className="px-0 hover:bg-transparent justify-end w-full h-6 text-xs font-medium" onClick={() => handleSort("available")}>
                        Available {sort.field === "available" && (sort.order === "asc" ? <ArrowUp className="ml-1 h-3 w-3 inline" /> : <ArrowDown className="ml-1 h-3 w-3 inline" />)}
                      </Button>
                    </TableHead>
                    <TableHead className="text-center py-2 text-xs font-medium h-8 w-[100px]">Status</TableHead>
                    <TableHead className="text-right py-2 text-xs font-medium h-8 pr-3 w-[80px]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variantsQuery.isError ? (
                    <TableRow>
                      <TableCell colSpan={8} className="h-24 text-center">
                        <p className="text-xs font-medium text-destructive">Inventory could not be loaded.</p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2 h-7 text-xs"
                          onClick={() => void variantsQuery.refetch()}
                        >
                          Retry
                        </Button>
                      </TableCell>
                    </TableRow>
                  ) : isInitialLoad ? (
                    <TableRow>
                      <TableCell colSpan={8} className="h-24 text-center">
                        <RefreshCw className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ) : variants.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="h-24 text-center text-xs text-muted-foreground">
                        {hasActiveFilters ? "No variants match your filters." : "No variants found."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    variants.map((v) => {
                      const badge = getStockBadge(v.available, v.lowStockThreshold);
                      return (
                        <TableRow key={v.id} className="hover:bg-muted/50">
                          <TableCell className="py-2 pl-3">
                            <Link to={`/admin/products/${v.productId}` as string} className="block w-[230px] truncate text-sm font-medium text-primary hover:underline">
                              {v.productName || "Unknown Product"}
                            </Link>
                          </TableCell>
                          <TableCell className="py-2 font-mono text-xs text-muted-foreground">{v.sku}</TableCell>
                          <TableCell className="py-2 text-sm text-muted-foreground">
                            {v.optionLabel || "\u2014"}
                          </TableCell>
                          <TableCell className="py-2 text-right text-sm tabular-nums">{v.stock}</TableCell>
                          <TableCell className="py-2 text-right text-sm tabular-nums">
                            {v.reservedStock > 0 ? (
                              <span className="text-amber-600 dark:text-amber-400">{v.reservedStock}</span>
                            ) : (
                              <span className="text-muted-foreground opacity-50">0</span>
                            )}
                          </TableCell>
                          <TableCell className="py-2 text-right text-sm font-semibold tabular-nums">{v.available}</TableCell>
                          <TableCell className="py-2 text-center">
                            <Badge variant={badge.variant} className={cn("px-1.5 py-0 text-xs", badge.className)}>
                              {badge.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-2 text-right pr-3 flex justify-end">
                            {inventoryActions.canAdjustStock ? (
                              <InventoryAdjustButton variant={v} onAdjust={setAdjustingVariant} />
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
            <PaginationControls
              pagination={pagination}
              onPageChange={(page) => setRequestedPage(page)}
              onLimitChange={(limit) => { setRequestedLimit(limit); setRequestedPage(1); }}
              itemName="variants"
            />
          </div>
        )}

        {/* Low-stock alerts tab */}
        {activeTab === "alerts" && (
          <div
            id="inventory-alerts-panel"
            role="tabpanel"
            aria-labelledby="inventory-alerts-tab"
            aria-busy={alertsQuery.isFetching}
            className="space-y-2 p-2 sm:p-3"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1 sm:max-w-xs">
                <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="Search low-stock alerts by product or SKU"
                  placeholder="Search product or SKU..."
                  value={alertLocalSearch}
                  onChange={(event) => {
                    setAlertLocalSearch(event.target.value);
                    setAlertsRequestedPage(1);
                  }}
                  className="h-8 pl-7 text-sm"
                />
              </div>
              <Select value={alertStatus} onValueChange={(value: AlertStatusFilter) => {
                setAlertStatus(value);
                setAlertsRequestedPage(1);
              }}>
                <SelectTrigger className="h-8 w-[160px] text-sm" aria-label="Filter low-stock alert status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Needs review</SelectItem>
                  <SelectItem value="acknowledged">Acknowledged</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="all">All alerts</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="relative overflow-hidden rounded-md border">
              {alertsQuery.isFetching && alerts.length > 0 ? (
                <div aria-hidden="true" className="absolute inset-0 z-10 bg-background/50 backdrop-blur-[1px]" />
              ) : null}
              <Table>
                <TableHeader>
                  <TableRow className="h-8 bg-muted/50 hover:bg-muted/50">
                    <TableHead className="h-8 pl-3 text-xs">Product / SKU</TableHead>
                    <TableHead className="h-8 text-right text-xs">Available</TableHead>
                    <TableHead className="h-8 text-right text-xs">Threshold</TableHead>
                    <TableHead className="h-8 text-xs">Status</TableHead>
                    <TableHead className="h-8 text-xs">Updated</TableHead>
                    <TableHead className="h-8 pr-3 text-right text-xs">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {alertsQuery.isError ? (
                    <TableRow><TableCell colSpan={6} className="h-24 text-center">
                      <p className="text-xs font-medium text-destructive">Low-stock alerts could not be loaded.</p>
                      <Button type="button" variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={() => void alertsQuery.refetch()}>Retry</Button>
                    </TableCell></TableRow>
                  ) : alertsQuery.isLoading ? (
                    <TableRow><TableCell colSpan={6} className="h-24 text-center"><RefreshCw className="mx-auto h-4 w-4 animate-spin text-muted-foreground" /></TableCell></TableRow>
                  ) : alerts.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="h-24 text-center text-xs text-muted-foreground">
                      {alertStatus === "active" ? "No low-stock alerts need review." : "No alerts match this view."}
                    </TableCell></TableRow>
                  ) : alerts.map((alert) => {
                    const statusLabel = alert.alertStatus === "active" ? "Needs review" : alert.alertStatus === "acknowledged" ? "Acknowledged" : "Resolved";
                    const statusClass = alert.alertStatus === "active"
                      ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-400"
                      : alert.alertStatus === "resolved"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-400"
                        : "border-border bg-muted text-muted-foreground";
                    const statusTime = alert.updatedAt;
                    return (
                      <TableRow key={alert.id}>
                        <TableCell className="py-2 pl-3">
                          <Link to={`/admin/products/${alert.productId}` as string} className="block max-w-[260px] truncate text-sm font-medium text-primary hover:underline">
                            {alert.productName || "Unknown product"}
                          </Link>
                          <span className="font-mono text-xs text-muted-foreground">{alert.variantSku || alert.variantId}</span>
                          {alert.variantLabel ? <span className="ml-2 text-xs text-muted-foreground">{alert.variantLabel}</span> : null}
                        </TableCell>
                        <TableCell className="py-2 text-right text-sm font-semibold tabular-nums">{alert.currentQty}</TableCell>
                        <TableCell className="py-2 text-right text-sm tabular-nums text-muted-foreground">{alert.threshold}</TableCell>
                        <TableCell className="py-2"><Badge variant="outline" className={cn("px-1.5 py-0 text-xs", statusClass)}>{statusLabel}</Badge></TableCell>
                        <TableCell className="whitespace-nowrap py-2 text-xs text-muted-foreground">{statusTime ? timeAgo(statusTime) : "—"}</TableCell>
                        <TableCell className="py-2 pr-3 text-right">
                          <div className="flex justify-end gap-1">
                            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => reviewAlertSku(alert)}>Review SKU</Button>
                            {alert.alertStatus === "active" && inventoryActions.canAcknowledgeAlerts ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={acknowledgeAlertMutation.isPending}
                                onClick={() => acknowledgeAlertMutation.mutate(alert.variantId)}
                              >
                                <Check className="mr-1 h-3.5 w-3.5" /> Acknowledge
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <PaginationControls
              pagination={alertsPagination}
              onPageChange={setAlertsRequestedPage}
              onLimitChange={(limit) => { setAlertsRequestedLimit(limit); setAlertsRequestedPage(1); }}
              itemName="alerts"
            />
          </div>
        )}

        {/* Movements Tab */}
        {activeTab === "movements" && (
          <div
            id="inventory-movements-panel"
            role="tabpanel"
            aria-labelledby="inventory-movements-tab"
            aria-busy={movementsQuery.isFetching}
            className="p-2 sm:p-3 space-y-2"
          >
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_minmax(180px,.8fr)_160px_150px_150px_auto]">
              <div className="relative">
                <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="Search movements by product or SKU"
                  placeholder="Search product or SKU..."
                  value={movementLocalSearch}
                  onChange={(event) => {
                    setMovementLocalSearch(event.target.value);
                    setMovementCursorHistory([""]);
                  }}
                  className="h-8 pl-7 text-sm"
                />
              </div>
              <Input
                type="search"
                aria-label="Filter movements by exact order ID"
                placeholder="Exact order ID"
                value={movementOrderId}
                onChange={(event) => {
                  setMovementOrderId(event.target.value);
                  setMovementCursorHistory([""]);
                }}
                className="h-8 text-sm"
              />
              <Select value={movementType} onValueChange={(value: MovementTypeFilter) => {
                setMovementType(value);
                setMovementCursorHistory([""]);
              }}>
                <SelectTrigger className="h-8 w-full text-sm" aria-label="Filter movement type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All movements</SelectItem>
                  <SelectItem value="adjusted">Adjusted</SelectItem>
                  <SelectItem value="reserved">Reserved</SelectItem>
                  <SelectItem value="deducted">Deducted</SelectItem>
                  <SelectItem value="released">Released</SelectItem>
                  <SelectItem value="restored">Restored</SelectItem>
                  <SelectItem value="preorder_reserved">Preorder reserved</SelectItem>
                  <SelectItem value="preorder_deducted">Preorder deducted</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="date"
                aria-label="Movement start date"
                max={movementEndDate || undefined}
                value={movementStartDate}
                onChange={(event) => {
                  setMovementStartDate(event.target.value);
                  setMovementCursorHistory([""]);
                }}
                className="h-8 text-sm"
              />
              <Input
                type="date"
                aria-label="Movement end date"
                min={movementStartDate || undefined}
                value={movementEndDate}
                onChange={(event) => {
                  setMovementEndDate(event.target.value);
                  setMovementCursorHistory([""]);
                }}
                className="h-8 text-sm"
              />
              <div className="flex items-center justify-end gap-1">
                {hasMovementFilters ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-1.5 text-xs text-muted-foreground"
                    onClick={() => {
                      setMovementLocalSearch("");
                      setMovementOrderId("");
                      setMovementStartDate("");
                      setMovementEndDate("");
                      setMovementType("all");
                      setMovementCursorHistory([""]);
                    }}
                  >
                    <X className="mr-1 h-3.5 w-3.5" /> Clear
                  </Button>
                ) : null}
                <Button asChild type="button" variant="outline" size="sm" className="h-8 px-2 text-xs">
                  <a href={movementExportHref} download>
                    <Download className="mr-1 h-3.5 w-3.5" /> Export CSV
                  </a>
                </Button>
              </div>
            </div>
            {ledgerHealth ? (
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{ledgerHealth.v2Rows} verified v2 movements across {ledgerHealth.v2Variants} SKUs</span>
                {ledgerHealth.legacyRows > 0 ? <span>{ledgerHealth.legacyRows} legacy history rows</span> : null}
                {ledgerHealth.invalidV2Rows > 0 ? (
                  <span className="font-medium text-destructive">{ledgerHealth.invalidV2Rows} invalid v2 rows require reconciliation</span>
                ) : null}
              </div>
            ) : null}
            <div className="border rounded-md overflow-hidden relative">
              {loading && movements.length > 0 && (
                <div aria-hidden="true" className="absolute inset-0 bg-background/50 backdrop-blur-[1px] z-10" />
              )}
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead className="py-2 text-xs font-medium h-8 pl-3">Type</TableHead>
                    <TableHead className="py-2 text-xs font-medium h-8">Variant / SKU</TableHead>
                    <TableHead className="py-2 text-xs font-medium h-8 w-[200px]">Notes</TableHead>
                    <TableHead className="text-right py-2 text-xs font-medium h-8">Change</TableHead>
                    <TableHead className="text-right py-2 text-xs font-medium h-8 pr-3">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movementsQuery.isError ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center">
                        <p className="text-xs font-medium text-destructive">Inventory movements could not be loaded.</p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2 h-7 text-xs"
                          onClick={() => void movementsQuery.refetch()}
                        >
                          Retry
                        </Button>
                      </TableCell>
                    </TableRow>
                  ) : movementsQuery.isLoading ? (
                    <TableRow><TableCell colSpan={5} className="h-24 text-center"><RefreshCw className="h-4 w-4 animate-spin mx-auto text-muted-foreground" /></TableCell></TableRow>
                  ) : movements.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="h-24 text-center text-xs text-muted-foreground">{hasMovementFilters ? "No movements match these filters." : "No movements recorded yet."}</TableCell></TableRow>
                  ) : (
                    movements.map((m) => {
                      const badge = getMovementBadge(m.type);
                      const counterChanges = getMovementCounterChanges(m);
                      return (
                        <TableRow key={m.id} className="hover:bg-muted/50">
                          <TableCell className="py-2 pl-3">
                            <Badge variant="outline" className={cn("whitespace-nowrap px-1.5 py-0 text-xs font-medium", badge.className)}>
                              {badge.label}
                            </Badge>
                            {m.ledgerVersion === 2 && m.pool ? (
                              <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                                {m.pool}{m.reservationGeneration ? ` · g${m.reservationGeneration}` : ""}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell className="py-2 text-sm">
                            <div className="font-medium text-foreground">{m.variantSku || m.variantId.slice(0, 8)}</div>
                            <div className="text-muted-foreground truncate max-w-[200px]">{m.productName}</div>
                            {m.orderId ? (
                              <Link
                                to={`/admin/orders/${m.orderId}` as string}
                                className="text-xs text-primary hover:underline"
                              >
                                Order {m.orderId.slice(0, 8)}
                              </Link>
                            ) : null}
                          </TableCell>
                          <TableCell className="py-2 text-xs text-muted-foreground truncate max-w-[200px]">
                            <div className="truncate">{m.notes || "\u2014"}</div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
                              {m.actorType === "system" ? "System" : `By ${m.actorName}`}
                            </div>
                          </TableCell>
                          <TableCell className="py-2 text-right">
                            <div className="space-y-0.5">
                              {counterChanges.map((change) => (
                                <div key={change.label} className="whitespace-nowrap">
                                  <span className="text-xs text-muted-foreground">{change.label} </span>
                                  <span className={cn("text-sm font-semibold", change.delta > 0 ? "text-emerald-600 dark:text-emerald-400" : change.delta < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                                    {change.delta > 0 ? "+" : ""}{change.delta}
                                  </span>
                                  <span className="ml-1 text-xs text-muted-foreground">{change.previous} → {change.next}</span>
                                </div>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell
                            className="whitespace-nowrap py-2 pr-3 text-right text-xs text-muted-foreground"
                            title={formatMovementTimestamp(m.createdAt)}
                          >
                            {timeAgo(m.createdAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
            <MovementCursorControls
              page={movementCursorHistory.length}
              limit={movementsRequestedLimit}
              canGoBack={movementCursorHistory.length > 1}
              canGoForward={Boolean(movementsPageInfo?.hasMore && movementsPageInfo.nextCursor)}
              loading={movementsQuery.isFetching}
              onBack={() => setMovementCursorHistory((history) => history.length > 1 ? history.slice(0, -1) : history)}
              onForward={() => {
                const nextCursor = movementsPageInfo?.nextCursor;
                if (!nextCursor) return;
                setMovementCursorHistory((history) => history.at(-1) === nextCursor ? history : [...history, nextCursor]);
              }}
              onLimitChange={(limit) => {
                setMovementsRequestedLimit(limit);
                setMovementCursorHistory([""]);
              }}
            />
          </div>
        )}
      </CardContent>

      {/* Adjust Modal — shadcn Dialog */}
      {inventoryActions.canAdjustStock && (
        <AdjustDialog
          variant={adjustingVariant}
          onClose={() => setAdjustingVariant(null)}
          onSubmit={refresh}
        />
      )}
    </Card>
  );
}

// ---------- Sub-components ----------

function InventoryVariantMobileList({
  variants,
  isError,
  isInitialLoad,
  isRefreshing,
  hasActiveFilters,
  canAdjust,
  onAdjust,
  onRetry,
}: {
  variants: InventoryVariant[];
  isError: boolean;
  isInitialLoad: boolean;
  isRefreshing: boolean;
  hasActiveFilters: boolean;
  canAdjust: boolean;
  onAdjust: (variant: InventoryVariant) => void;
  onRetry: () => void;
}) {
  return (
    <div data-inventory-layout="mobile" className="relative md:hidden">
      {isRefreshing && variants.length > 0 ? (
        <div aria-hidden="true" className="absolute inset-0 z-10 rounded-md bg-background/50 backdrop-blur-[1px]" />
      ) : null}

      {isError ? (
        <div className="rounded-md border px-3 py-6 text-center">
          <p className="text-xs font-medium text-destructive">Inventory could not be loaded.</p>
          <Button type="button" variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : isInitialLoad ? (
        <div role="status" className="rounded-md border px-3 py-6 text-center">
          <RefreshCw className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
          <span className="sr-only">Loading inventory variants</span>
        </div>
      ) : variants.length === 0 ? (
        <p className="rounded-md border px-3 py-6 text-center text-xs text-muted-foreground">
          {hasActiveFilters ? "No variants match your filters." : "No variants found."}
        </p>
      ) : (
        <ul aria-label="Inventory variants" className="space-y-2">
          {variants.map((variant) => {
            const badge = getStockBadge(variant.available, variant.lowStockThreshold);
            const productName = variant.productName || "Unknown Product";

            return (
              <li key={variant.id} className="overflow-hidden rounded-md border bg-card">
                <div className="flex min-w-0 items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <Link
                      to={`/admin/products/${variant.productId}` as string}
                      className="block break-words text-sm font-medium leading-5 text-primary hover:underline"
                    >
                      {productName}
                    </Link>
                    <p className="mt-0.5 break-all font-mono text-xs leading-4 text-muted-foreground">
                      {variant.sku}
                    </p>
                    <p className="mt-0.5 break-words text-xs leading-4 text-muted-foreground">
                      {variant.optionLabel || "Default variant"}
                    </p>
                  </div>
                  <Badge variant={badge.variant} className={cn("shrink-0 px-1.5 py-0 text-xs", badge.className)}>
                    {badge.label}
                  </Badge>
                </div>

                <dl className="grid grid-cols-3 border-t bg-muted/20">
                  <div className="min-w-0 px-2 py-2 text-center">
                    <dt className="text-xs text-muted-foreground">On hand</dt>
                    <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{variant.stock}</dd>
                  </div>
                  <div className="min-w-0 border-x px-2 py-2 text-center">
                    <dt className="text-xs text-muted-foreground">Committed</dt>
                    <dd className={cn("mt-0.5 text-sm font-semibold tabular-nums", variant.reservedStock > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                      {variant.reservedStock}
                    </dd>
                  </div>
                  <div className="min-w-0 px-2 py-2 text-center">
                    <dt className="text-xs text-muted-foreground">Available</dt>
                    <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{variant.available}</dd>
                  </div>
                </dl>

                {canAdjust ? (
                  <div className="flex justify-end border-t px-2 py-1">
                    <InventoryAdjustButton variant={variant} onAdjust={onAdjust} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function InventoryAdjustButton({
  variant,
  onAdjust,
}: {
  variant: InventoryVariant;
  onAdjust: (variant: InventoryVariant) => void;
}) {
  const productName = variant.productName || "Unknown Product";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-sm font-medium"
      aria-label={`Adjust stock for ${productName}, SKU ${variant.sku}`}
      onClick={() => onAdjust(variant)}
    >
      <ArrowUpDown className="mr-1 h-3 w-3" /> Adjust
    </Button>
  );
}

function PaginationControls({
  pagination,
  onPageChange,
  onLimitChange,
  itemName
}: {
  pagination: InventoryPagination | null;
  onPageChange: (p: number) => void;
  onLimitChange: (l: number) => void;
  itemName: string;
}) {
  if (!pagination || pagination.total === 0) return null;

  return (
    <AdminListPagination
      pagination={pagination}
      itemLabel={itemName}
      onPageChange={onPageChange}
      onLimitChange={onLimitChange}
      pageSizeOptions={[10, 20, 50, 100]}
    />
  );
}

function MovementCursorControls({
  page,
  limit,
  canGoBack,
  canGoForward,
  loading,
  onBack,
  onForward,
  onLimitChange,
}: {
  page: number;
  limit: number;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  onBack: () => void;
  onForward: () => void;
  onLimitChange: (limit: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span>Page {page}</span>
        <Select value={String(limit)} onValueChange={(value) => onLimitChange(Number(value))}>
          <SelectTrigger className="h-7 w-[116px] text-xs" aria-label="Movement rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[20, 50, 100].map((size) => (
              <SelectItem key={size} value={String(size)}>{size} per page</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={!canGoBack || loading}
          onClick={onBack}
        >
          <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={!canGoForward || loading}
          onClick={onForward}
        >
          Next <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function AdjustDialog({ variant, onClose, onSubmit }: { variant: InventoryVariant | null; onClose: () => void; onSubmit: () => void }) {
  const [mode, setMode] = useState<AdjustmentMode>("relative");
  const [deltaInput, setDeltaInput] = useState("0");
  const [countInput, setCountInput] = useState("0");
  const [reason, setReason] =
    useState<InventoryAdjustmentReason>("received");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const operationIntentRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const delta = Number(deltaInput);
  const countedStock = Number(countInput);
  const relativeInputValid = deltaInput.trim() !== "" && Number.isSafeInteger(delta) && delta !== 0;
  const stocktakeInputValid = countInput.trim() !== "" && Number.isSafeInteger(countedStock) && countedStock >= 0;
  const targetStock = variant
    ? mode === "stocktake" ? countedStock : variant.stock + delta
    : 0;
  const targetIsValid = mode === "stocktake"
    ? stocktakeInputValid
    : relativeInputValid && Number.isSafeInteger(targetStock) && targetStock >= 0;
  const effectiveDelta = variant ? targetStock - variant.stock : 0;
  const canSubmit = Boolean(
    variant &&
    !submitting &&
    targetIsValid &&
    effectiveDelta !== 0 &&
    (mode === "relative" ? relativeInputValid : stocktakeInputValid),
  );

  const resetForm = () => {
    setMode("relative");
    setDeltaInput("0");
    setCountInput("0");
    setReason("received");
    setNotes("");
    operationIntentRef.current = null;
  };

  const operationKeyForIntent = (fingerprint: string) => {
    if (operationIntentRef.current?.fingerprint === fingerprint) {
      return operationIntentRef.current.key;
    }
    const key = createInventoryOperationKey();
    operationIntentRef.current = { fingerprint, key };
    return key;
  };

  const updateRelativeDelta = (nextValue: string) => {
    setDeltaInput(nextValue);
    const nextDelta = Number(nextValue);
    if (nextDelta < 0 && (reason === "received" || reason === "return")) {
      setReason("damage");
    } else if (nextDelta > 0 && (reason === "damage" || reason === "theft")) {
      setReason("received");
    }
  };

  const handleSubmit = async () => {
    if (!variant || !canSubmit) return;
    setSubmitting(true);
    try {
      if (mode === "stocktake") {
        const stocktakeReason = notes.trim() || "Manual stocktake";
        const operationKey = operationKeyForIntent(JSON.stringify({
          mode,
          variantId: variant.id,
          newStock: countedStock,
          reason: stocktakeReason,
        }));
        await stockSet({
          data: {
            operationKey,
            variantId: variant.id,
            newStock: countedStock,
            reason: stocktakeReason,
          },
        });
      } else {
        const trimmedNotes = notes.trim();
        const operationKey = operationKeyForIntent(JSON.stringify({
          mode,
          variantId: variant.id,
          delta,
          reason,
          notes: trimmedNotes || null,
        }));
        await adjustInventory({
          data: {
            operationKey,
            variantId: variant.id,
            delta,
            reason,
            ...(trimmedNotes ? { notes: trimmedNotes } : {}),
          },
        });
      }
      onSubmit();
      onClose();
      resetForm();
    } catch (error) {
      console.error("Failed to adjust stock:", error);
      toast.error(error instanceof Error ? error.message : "Failed to adjust stock");
    } finally {
      setSubmitting(false);
    }
  };

  // Reset form state when a new variant is selected
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
      resetForm();
    }
  };

  const newAvailable = variant ? targetStock - variant.reservedStock : 0;
  const reasonOptions = delta < 0
    ? [
      ["damage", "Damaged / write-off"],
      ["theft", "Theft / shrinkage"],
      ["correction", "Count correction"],
      ["other", "Other"],
    ] as const
    : [
      ["received", "Stock received"],
      ["return", "Customer return"],
      ["correction", "Count correction"],
      ["other", "Other"],
    ] as const;

  return (
    <Dialog open={!!variant} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Adjust Stock</DialogTitle>
          <DialogDescription className="text-sm">
            {variant && (
              <>
                <span className="font-medium text-foreground">{variant.productName}</span> — <span className="font-mono">{variant.sku}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {variant && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-muted/50 rounded-md p-2 border">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">On hand</div>
                <div className="text-sm font-bold mt-0.5">{variant.stock}</div>
              </div>
              <div className="bg-muted/50 rounded-md p-2 border">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Committed</div>
                <div className="text-sm font-bold mt-0.5 text-amber-600 dark:text-amber-400">{variant.reservedStock}</div>
              </div>
              <div className="bg-muted/50 rounded-md p-2 border">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Available</div>
                <div className="text-sm font-bold mt-0.5 text-emerald-600 dark:text-emerald-400">{variant.available}</div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="inventory-adjustment-mode" className="text-sm font-medium text-foreground">Operation</label>
              <Select
                value={mode}
                onValueChange={(value: AdjustmentMode) => {
                  setMode(value);
                  if (value === "stocktake" && variant) {
                    setCountInput(String(variant.stock));
                  }
                }}
              >
                <SelectTrigger id="inventory-adjustment-mode" className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="relative">Add or remove stock</SelectItem>
                  <SelectItem value="stocktake">Set counted stock</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {mode === "stocktake"
                  ? "Use the physical count. The audit log records the calculated difference."
                  : "Enter the exact quantity received or removed."}
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="inventory-adjustment-amount" className="text-sm font-medium text-foreground">
                {mode === "stocktake" ? "Counted on hand" : "Adjustment amount"}
              </label>
              {mode === "stocktake" ? (
                <Input
                  id="inventory-adjustment-amount"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={countInput}
                  onChange={(event) => setCountInput(event.target.value)}
                  className="h-9 text-center text-sm font-semibold"
                />
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    aria-label="Decrease adjustment by one"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={() => updateRelativeDelta(String((Number.isSafeInteger(delta) ? delta : 0) - 1))}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <Input
                    id="inventory-adjustment-amount"
                    type="number"
                    step={1}
                    inputMode="numeric"
                    value={deltaInput}
                    onChange={(event) => updateRelativeDelta(event.target.value)}
                    className="h-9 text-center text-sm font-semibold"
                  />
                  <Button
                    type="button"
                    aria-label="Increase adjustment by one"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={() => updateRelativeDelta(String((Number.isSafeInteger(delta) ? delta : 0) + 1))}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
              {effectiveDelta !== 0 && targetIsValid ? (
                <p className="mt-1 text-center text-xs text-muted-foreground">
                  New on hand: <span className="font-medium">{targetStock}</span> {"\u2192"}{" "}
                  Available: <span className={cn("font-medium", newAvailable <= 0 ? "text-red-500" : "text-emerald-600")}>{newAvailable}</span>
                </p>
              ) : null}
              {!targetIsValid ? (
                <p role="alert" className="text-xs font-medium text-destructive">
                  Stock cannot be negative or fractional. Enter the exact whole-number operation.
                </p>
              ) : null}
              {targetIsValid && newAvailable < 0 ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  This count leaves an availability deficit of {Math.abs(newAvailable)} against existing reservations.
                </p>
              ) : null}
            </div>

            {mode === "relative" ? <div className="space-y-1.5">
              <label htmlFor="inventory-adjustment-reason" className="text-sm font-medium text-foreground">Reason</label>
              <Select
                value={reason}
                onValueChange={(value) =>
                  setReason(value as InventoryAdjustmentReason)
                }
              >
                <SelectTrigger id="inventory-adjustment-reason" className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="text-sm">
                  {reasonOptions.map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div> : null}

            <div className="space-y-1.5">
              <label htmlFor="inventory-adjustment-notes" className="text-sm font-medium text-foreground">
                {mode === "stocktake" ? "Stocktake note" : "Notes (optional)"}
              </label>
              <Input id="inventory-adjustment-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Add context for audit log..." className="h-9 text-sm" />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} className="h-8 text-sm">Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit} className="h-8 text-sm">
            {submitting
              ? "Applying..."
              : mode === "stocktake"
                ? `Set to ${stocktakeInputValid ? countedStock : "—"}`
                : `Apply ${relativeInputValid && delta > 0 ? "+" : ""}${relativeInputValid ? delta : "—"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
