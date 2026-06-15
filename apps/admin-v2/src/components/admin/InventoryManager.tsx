// src/components/admin/InventoryManager.tsx
// Rebuilt Inventory Management Dashboard (Premium UI/UX).
// Uses TanStack Query for data fetching and shadcn Dialog for the adjust modal.

import { Link } from "@tanstack/react-router";
import { useState, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Package, ArrowUpDown, History, AlertTriangle, Search, RefreshCw, Plus, Minus, X, ArrowUp, ArrowDown } from "lucide-react";
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
import { StatCard } from "@/components/admin/shared/StatCard";
import { inventoryQueryOptions } from "@/lib/api-query-options/inventory";
import {
  adjustInventory,
  type InventoryMovement,
  type InventoryPagination,
  type InventoryStats,
  type InventoryVariant,
  type InventoryAdjustmentReason,
} from "@/lib/api-functions/inventory";
import { useDebounce } from "@/hooks/use-debounce";

// ---------- Types ----------

type Tab = "variants" | "movements";
type StockFilter = "all" | "low" | "out" | "reserved";
type SortField = "productName" | "sku" | "available";
type SortOrder = "asc" | "desc";

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
  };
  return map[type] ?? { label: type, className: "bg-gray-50 text-gray-700 border-gray-200" };
}

function timeAgo(dateValue: string | number) {
  const dateStr =
    typeof dateValue === "number" ? dateValue * 1000 : dateValue;
  const date = new Date(dateStr);
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

// ---------- Main Component ----------

export function InventoryManager() {
  // Local UI state
  const [activeTab, setActiveTab] = useState<Tab>("variants");
  const [requestedPage, setRequestedPage] = useState(1);
  const [requestedLimit, setRequestedLimit] = useState(50);
  const [movementsRequestedPage, setMovementsRequestedPage] = useState(1);
  const [movementsRequestedLimit, setMovementsRequestedLimit] = useState(50);
  const [localSearch, setLocalSearch] = useState("");
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [sort, setSort] = useState<{ field: SortField; order: SortOrder }>({ field: "available", order: "asc" });
  const [adjustingVariant, setAdjustingVariant] = useState<InventoryVariant | null>(null);

  const queryClient = useQueryClient();
  const search = useDebounce(localSearch, 300);

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
      page: movementsRequestedPage,
      limit: movementsRequestedLimit,
    }),
    placeholderData: keepPreviousData,
    enabled: activeTab === "movements",
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
    if (!raw) return { movements: [] as InventoryMovement[], pagination: null as InventoryPagination | null };
    return {
      movements: raw.movements || [],
      pagination: raw.pagination || null,
    };
  }, [movementsQuery.data]);

  const { variants, stats, pagination } = variantsData;
  const { movements, pagination: movementsPagination } = movementsData;

  const loading = activeTab === "variants" ? variantsQuery.isFetching : movementsQuery.isFetching;
  const isInitialLoad = activeTab === "variants" ? variantsQuery.isLoading : movementsQuery.isLoading;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["inventory"] });
  }, [queryClient]);

  const clearFilters = useCallback(() => {
    setLocalSearch("");
    setStockFilter("all");
  }, []);

  const handleSort = useCallback((field: SortField) => {
    setSort(prev => ({
      field,
      order: prev.field === field && prev.order === "asc" ? "desc" : "asc"
    }));
  }, []);

  const hasActiveFilters = localSearch.trim() || stockFilter !== "all";

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

        {stats && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <StatCard title="Total SKUs" value={stats.totalVariants} icon={Package} iconBgColor="bg-blue-100 dark:bg-blue-900/30" iconTextColor="text-blue-600 dark:text-blue-400" />
            <StatCard title="On Hand" value={stats.totalOnHand} icon={Package} iconBgColor="bg-slate-100 dark:bg-slate-900/30" iconTextColor="text-slate-600 dark:text-slate-400" />
            <StatCard title="Reserved" value={stats.totalReserved} icon={History} iconBgColor="bg-amber-100 dark:bg-amber-900/30" iconTextColor="text-amber-600 dark:text-amber-400" />
            <StatCard title="Available" value={stats.totalAvailable} icon={Package} iconBgColor="bg-emerald-100 dark:bg-emerald-900/30" iconTextColor="text-emerald-600 dark:text-emerald-400" />
            <StatCard title="Low Stock" value={stats.lowStockCount} icon={AlertTriangle} iconBgColor="bg-amber-100 dark:bg-amber-900/30" iconTextColor="text-amber-600 dark:text-amber-400" />
            <StatCard title="Out of Stock" value={stats.outOfStockCount} icon={AlertTriangle} iconBgColor="bg-red-100 dark:bg-red-900/30" iconTextColor="text-red-600 dark:text-red-400" />
          </div>
        )}
      </CardHeader>

      <CardContent className="p-0">
        {/* Tabs */}
        <div className="border-b px-2 sm:px-3">
          <nav className="flex gap-4">
            <button
              onClick={() => setActiveTab("variants")}
              className={cn("flex items-center gap-2 py-2 text-xs font-medium border-b-2 transition-colors", activeTab === "variants" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              <Package className="h-3.5 w-3.5" /> All Variants
            </button>
            <button
              onClick={() => setActiveTab("movements")}
              className={cn("flex items-center gap-2 py-2 text-xs font-medium border-b-2 transition-colors", activeTab === "movements" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              <History className="h-3.5 w-3.5" /> Recent Movements
            </button>
          </nav>
        </div>

        {/* Variants Tab */}
        {activeTab === "variants" && (
          <div className="p-2 sm:p-3 space-y-2">
            {/* Toolbar */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <div className="flex flex-1 items-center w-full sm:w-auto space-x-1.5">
                <div className="relative flex-1 sm:max-w-xs">
                  <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search name or SKU..."
                    value={localSearch}
                    onChange={(e) => setLocalSearch(e.target.value)}
                    className="pl-7 h-7 w-full text-xs"
                  />
                </div>
                <Select value={stockFilter} onValueChange={(v: StockFilter) => setStockFilter(v)}>
                  <SelectTrigger className="h-7 w-[130px] text-xs">
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
                  <Button variant="ghost" size="sm" className="h-7 px-1.5 text-xs text-muted-foreground" onClick={clearFilters}>
                    <X className="h-3.5 w-3.5 mr-1" /> Clear
                  </Button>
                )}
              </div>
            </div>

            {/* Table */}
            <div className="border rounded-md overflow-hidden relative">
              {loading && variants.length > 0 && (
                <div className="absolute inset-0 bg-background/50 backdrop-blur-[1px] z-10" />
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
                  {isInitialLoad ? (
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
                            <Link to={`/admin/products/${v.productId}` as string} className="font-medium text-xs text-primary hover:underline block truncate w-[230px]">
                              {v.productName || "Unknown Product"}
                            </Link>
                          </TableCell>
                          <TableCell className="py-2 font-mono text-[11px] text-muted-foreground">{v.sku}</TableCell>
                          <TableCell className="py-2 text-xs text-muted-foreground">
                            {[v.size, v.color].filter(Boolean).join(" / ") || "\u2014"}
                          </TableCell>
                          <TableCell className="py-2 text-right text-xs">{v.stock}</TableCell>
                          <TableCell className="py-2 text-right text-xs">
                            {v.reservedStock > 0 ? (
                              <span className="text-amber-600 dark:text-amber-400">{v.reservedStock}</span>
                            ) : (
                              <span className="text-muted-foreground opacity-50">0</span>
                            )}
                          </TableCell>
                          <TableCell className="py-2 text-right text-xs font-semibold">{v.available}</TableCell>
                          <TableCell className="py-2 text-center">
                            <Badge variant={badge.variant} className={cn("text-[10px] px-1.5 py-0", badge.className)}>
                              {badge.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-2 text-right pr-3 flex justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[11px] font-medium"
                              onClick={() => setAdjustingVariant(v)}
                            >
                              <ArrowUpDown className="h-3 w-3 mr-1" /> Adjust
                            </Button>
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

        {/* Movements Tab */}
        {activeTab === "movements" && (
          <div className="p-2 sm:p-3">
            <div className="border rounded-md overflow-hidden relative">
              {loading && movements.length > 0 && (
                <div className="absolute inset-0 bg-background/50 backdrop-blur-[1px] z-10" />
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
                  {movementsQuery.isLoading ? (
                    <TableRow><TableCell colSpan={5} className="h-24 text-center"><RefreshCw className="h-4 w-4 animate-spin mx-auto text-muted-foreground" /></TableCell></TableRow>
                  ) : movements.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="h-24 text-center text-xs text-muted-foreground">No movements recorded yet.</TableCell></TableRow>
                  ) : (
                    movements.map((m) => {
                      const badge = getMovementBadge(m.type);
                      return (
                        <TableRow key={m.id} className="hover:bg-muted/50">
                          <TableCell className="py-2 pl-3">
                            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 font-medium whitespace-nowrap", badge.className)}>
                              {badge.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-2 text-xs">
                            <div className="font-medium text-foreground">{m.variantSku || m.variantId.slice(0, 8)}</div>
                            <div className="text-muted-foreground truncate max-w-[200px]">{m.productName}</div>
                          </TableCell>
                          <TableCell className="py-2 text-xs text-muted-foreground truncate max-w-[200px]">
                            {m.notes || "\u2014"}
                          </TableCell>
                          <TableCell className="py-2 text-right">
                            <div className={cn("text-xs font-bold", m.quantity > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                              {m.quantity > 0 ? "+" : ""}{m.quantity}
                            </div>
                            <div className="text-[10px] text-muted-foreground">{m.previousStock} → {m.newStock}</div>
                          </TableCell>
                          <TableCell className="py-2 text-right pr-3 text-[11px] text-muted-foreground whitespace-nowrap">
                            {timeAgo(m.createdAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
            <PaginationControls
              pagination={movementsPagination}
              onPageChange={(page) => setMovementsRequestedPage(page)}
              onLimitChange={(limit) => { setMovementsRequestedLimit(limit); setMovementsRequestedPage(1); }}
              itemName="movements"
            />
          </div>
        )}
      </CardContent>

      {/* Adjust Modal — shadcn Dialog */}
      <AdjustDialog
        variant={adjustingVariant}
        onClose={() => setAdjustingVariant(null)}
        onSubmit={refresh}
      />
    </Card>
  );
}

// ---------- Sub-components ----------

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

function AdjustDialog({ variant, onClose, onSubmit }: { variant: InventoryVariant | null; onClose: () => void; onSubmit: () => void }) {
  const [delta, setDelta] = useState(0);
  const [reason, setReason] =
    useState<InventoryAdjustmentReason>("received");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!variant || delta === 0) return;
    setSubmitting(true);
    try {
      await adjustInventory({
        data: { variantId: variant.id, delta, reason, ...(notes ? { notes } : {}) },
      });
      onSubmit();
      onClose();
      // Reset form state for next open
      setDelta(0);
      setReason("received");
      setNotes("");
    } catch (error) {
      console.error("Failed to adjust stock:", error);
      toast.error("Failed to adjust stock");
    } finally {
      setSubmitting(false);
    }
  };

  // Reset form state when a new variant is selected
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
      setDelta(0);
      setReason("received");
      setNotes("");
    }
  };

  const newStock = variant ? Math.max(0, variant.stock + delta) : 0;
  const newAvailable = variant ? Math.max(0, newStock - variant.reservedStock) : 0;

  return (
    <Dialog open={!!variant} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Adjust Stock</DialogTitle>
          <DialogDescription className="text-xs">
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
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">On Hand</div>
                <div className="text-sm font-bold mt-0.5">{variant.stock}</div>
              </div>
              <div className="bg-muted/50 rounded-md p-2 border">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Reserved</div>
                <div className="text-sm font-bold mt-0.5 text-amber-600 dark:text-amber-400">{variant.reservedStock}</div>
              </div>
              <div className="bg-muted/50 rounded-md p-2 border">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Available</div>
                <div className="text-sm font-bold mt-0.5 text-emerald-600 dark:text-emerald-400">{variant.available}</div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Adjustment Amount</label>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => setDelta(d => d - 1)}><Minus className="h-3.5 w-3.5" /></Button>
                <Input type="number" value={delta} onChange={(e) => setDelta(parseInt(e.target.value) || 0)} className="text-center font-bold h-8" />
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => setDelta(d => d + 1)}><Plus className="h-3.5 w-3.5" /></Button>
              </div>
              {delta !== 0 && (
                <p className="text-[11px] text-muted-foreground text-center mt-1">
                  New on hand: <span className="font-medium">{newStock}</span> {"\u2192"}{" "}
                  Available: <span className={cn("font-medium", newAvailable <= 0 ? "text-red-500" : "text-emerald-600")}>{newAvailable}</span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Reason</label>
              <Select
                value={reason}
                onValueChange={(value) =>
                  setReason(value as InventoryAdjustmentReason)
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="text-xs">
                  <SelectItem value="received">Stock Received</SelectItem>
                  <SelectItem value="correction">Count Correction</SelectItem>
                  <SelectItem value="return">Customer Return</SelectItem>
                  <SelectItem value="damage">Damaged / Write-off</SelectItem>
                  <SelectItem value="theft">Theft / Shrinkage</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Notes (optional)</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Add context for audit log..." className="h-8 text-xs" />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} className="h-7 text-xs">Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={delta === 0 || submitting} className="h-7 text-xs">
            {submitting ? "Applying..." : `Apply ${delta > 0 ? "+" : ""}${delta}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
