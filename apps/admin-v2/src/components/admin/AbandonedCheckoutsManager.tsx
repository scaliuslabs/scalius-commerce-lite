import React, { useState, useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCurrency } from "@/hooks/use-currency";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  RefreshCw,
  Trash2,
  Loader2,
  ShoppingCart,
  Info,
  Phone,
  User,
  ArrowUpDown,
  Eye,
  Mail,
  MessageSquareText,
  MapPin,
  Package,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import type { AbandonedCheckout } from "@/types/api-responses";
import { AdminListPagination } from "@/components/admin/shared/AdminListPagination";
import { DataTableToolbar } from "@/components/admin/data-table/DataTableToolbar";
import { abandonedCheckoutsQueryOptions } from "@/lib/api-query-options/abandoned-checkouts";
import { deleteAbandonedCheckouts } from "@/lib/api-functions/abandoned-checkouts";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import {
  formatAbandonedCheckoutId,
  formatAbandonedCheckoutItemCount,
  formatAbandonedCheckoutRecordCount,
  parseAbandonedCheckoutDisplay,
  type AbandonedCheckoutCartItem,
} from "@/lib/abandoned-checkout-display";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import type {
  AbandonedCheckoutRouteState,
  AbandonedCheckoutSort,
} from "@/lib/abandoned-checkout-route-state";
import { abandonedCheckoutRouteStateToQuery } from "@/lib/abandoned-checkout-route-state";
import { getCanonicalPageForPagination } from "@/lib/list-helpers";

// --- Type Definitions ---
interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// --- Utility Functions ---

const formatCurrency = (amount: number, sym: string) => {
  return `${sym}${amount.toFixed(2)}`;
};

const getCheckoutDisplayId = (checkout: AbandonedCheckout): string => {
  return checkout.checkoutId || checkout.id;
};

const timeSince = (date: Date | null): string => {
  if (!date || isNaN(date.getTime())) return "...";
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);

  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + "y ago";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + "mo ago";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + "d ago";
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + "h ago";
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + "m ago";
  return Math.floor(seconds) + "s ago";
};

// --- Sub-Components ---

const CheckoutRow = React.memo(
  ({
    checkout,
    isSelected,
    onToggleSelection,
    onViewDetails,
    onDelete,
    canDelete,
  }: {
    checkout: AbandonedCheckout;
    isSelected: boolean;
    onToggleSelection: (id: string) => void;
    onViewDetails: (checkout: AbandonedCheckout) => void;
    onDelete: (id: string) => void;
    canDelete: boolean;
  }) => {
    const { symbol } = useCurrency();
    const display = useMemo(
      () => parseAbandonedCheckoutDisplay(checkout),
      [checkout],
    );
    const displayId = getCheckoutDisplayId(checkout);
    const compactId = formatAbandonedCheckoutId(displayId);
    const isHostedArchive = display.kind === "stale_hosted_payment_order";
    const updatedAt = useMemo(
      () => (checkout.updatedAt ? new Date(checkout.updatedAt) : null),
      [checkout.updatedAt],
    );

    return (
      <TableRow className="h-11" data-state={isSelected ? "selected" : undefined}>
        <TableCell className="w-10">
          {canDelete && (
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelection(checkout.id)}
              aria-label={`Select incomplete checkout ${displayId}`}
            />
          )}
        </TableCell>
        <TableCell className="font-mono text-xs" title={displayId}>
          {compactId}
        </TableCell>
        <TableCell className="font-medium">
          {checkout.customerPhone ? formatPhoneForDisplay(checkout.customerPhone) : (
            <span className="text-muted-foreground">No phone</span>
          )}
        </TableCell>
        <TableCell>
          <Badge variant={display.variant}>{display.stage}</Badge>
        </TableCell>
        <TableCell>
          {display.kind === "stale_hosted_payment_order"
            ? `${display.paymentMethod?.toUpperCase() ?? "Gateway"} ${display.paymentStatus ?? "unpaid"} / ${formatCurrency(display.total, symbol)}`
            : `${formatAbandonedCheckoutItemCount(display.items.length)} / ${formatCurrency(display.total, symbol)}`}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {timeSince(updatedAt)}
        </TableCell>
        <TableCell className="text-right">
          {isHostedArchive && display.orderId && (
            <Button
              variant="ghost"
              size="icon"
              asChild
              aria-label={`View archived hosted-payment order ${display.orderId}`}
              title="View order"
            >
              <Link to={`/admin/orders/${display.orderId}` as string}>
                <ExternalLink className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onViewDetails(checkout)}
            aria-label={`View incomplete checkout ${displayId}`}
            title="View details"
          >
            <Eye className="h-4 w-4" />
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDelete(checkout.id)}
              aria-label={`Delete incomplete checkout ${displayId}`}
              title={isHostedArchive ? "Delete recovery record" : "Delete checkout record"}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          )}
        </TableCell>
      </TableRow>
    );
  },
);

const CheckoutCard = React.memo(
  ({
    checkout,
    isSelected,
    onToggleSelection,
    onViewDetails,
    onDelete,
    canDelete,
  }: {
    checkout: AbandonedCheckout;
    isSelected: boolean;
    onToggleSelection: (id: string) => void;
    onViewDetails: (checkout: AbandonedCheckout) => void;
    onDelete: (id: string) => void;
    canDelete: boolean;
  }) => {
    const { symbol } = useCurrency();
    const display = useMemo(
      () => parseAbandonedCheckoutDisplay(checkout),
      [checkout],
    );
    const displayId = getCheckoutDisplayId(checkout);
    const compactId = formatAbandonedCheckoutId(displayId);
    const isHostedArchive = display.kind === "stale_hosted_payment_order";
    const updatedAt = useMemo(
      () => (checkout.updatedAt ? new Date(checkout.updatedAt) : null),
      [checkout.updatedAt],
    );
    const cartSummary = isHostedArchive
      ? `${display.paymentMethod?.toUpperCase() ?? "Gateway"} ${display.paymentStatus ?? "unpaid"} · ${formatCurrency(display.total, symbol)}`
      : `${display.items.length} ${display.items.length === 1 ? "item" : "items"} · ${formatCurrency(display.total, symbol)}`;

    return (
      <article className="border-b px-3 py-2.5 last:border-b-0" data-state={isSelected ? "selected" : undefined}>
        <div className="flex min-w-0 items-start gap-2.5">
          {canDelete ? (
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelection(checkout.id)}
              aria-label={`Select incomplete checkout ${displayId}`}
              className="mt-0.5"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate font-mono text-xs font-medium" title={displayId}>{compactId}</span>
              <Badge variant={display.variant} className="shrink-0 px-1.5 py-0 text-[10px]">{display.stage}</Badge>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Customer</p>
                <p className="mt-0.5 truncate font-medium">
                  {checkout.customerPhone ? formatPhoneForDisplay(checkout.customerPhone) : "No phone"}
                </p>
              </div>
              <div className="min-w-0 text-right">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Saved cart</p>
                <p className="mt-0.5 truncate font-medium" title={cartSummary}>{cartSummary}</p>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between border-t pt-1.5">
          <span className="text-[11px] text-muted-foreground">Updated {timeSince(updatedAt)}</span>
          <div className="flex items-center gap-1">
            {isHostedArchive && display.orderId ? (
              <Button variant="ghost" size="sm" asChild className="h-7 px-2 text-xs">
                <Link to={`/admin/orders/${display.orderId}` as string} aria-label={`View archived hosted-payment order ${display.orderId}`}>
                  <ExternalLink className="mr-1 h-3.5 w-3.5" /> Order
                </Link>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onViewDetails(checkout)}
              aria-label={`View incomplete checkout ${displayId}`}
            >
              <Eye className="mr-1 h-3.5 w-3.5" /> View
            </Button>
            {canDelete ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => onDelete(checkout.id)}
                aria-label={`Delete incomplete checkout ${displayId}`}
                title={isHostedArchive ? "Delete recovery record" : "Delete checkout record"}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            ) : null}
          </div>
        </div>
      </article>
    );
  },
);

const DetailsModal = ({
  checkout,
  onClose,
}: {
  checkout: AbandonedCheckout | null;
  onClose: () => void;
}) => {
  const { symbol } = useCurrency();
  if (!checkout) return null;

  const display = parseAbandonedCheckoutDisplay(checkout);
  const { items, total, customerInfo } = display;
  const displayId = getCheckoutDisplayId(checkout);

  return (
    <Dialog open={!!checkout} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl gap-0 p-0 overflow-hidden">
        <DialogHeader>
          <div className="border-b px-5 py-4">
            <DialogTitle>Incomplete checkout</DialogTitle>
            <DialogDescription>
              Saved recovery context for{" "}
              <span
                className="font-mono text-xs"
                title={displayId}
                aria-label={`Checkout ID ${displayId}`}
              >
                {formatAbandonedCheckoutId(displayId)}
              </span>
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="grid max-h-[65vh] gap-5 overflow-y-auto p-5 md:grid-cols-2">
          {display.kind === "stale_hosted_payment_order" && (
            <div className="md:col-span-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">Archived hosted-payment order</p>
                  <p className="mt-1 opacity-90">
                    This was a stale online checkout order that never received a successful payment.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-80">
                    {display.paymentMethod && <span>Gateway: {display.paymentMethod.toUpperCase()}</span>}
                    {display.paymentStatus && <span>Status: {display.paymentStatus}</span>}
                    {display.paidAmount != null && <span>Paid: {formatCurrency(display.paidAmount, symbol)}</span>}
                    {display.balanceDue != null && <span>Balance: {formatCurrency(display.balanceDue, symbol)}</span>}
                  </div>
                </div>
                {display.orderId && (
                  <Button asChild variant="outline" size="sm" className="shrink-0 bg-white/70 dark:bg-black/10">
                    <Link to={`/admin/orders/${display.orderId}` as string}>
                      View order
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          )}
          <div className="space-y-4">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <User className="h-5 w-5 text-primary" /> Customer Information
            </h3>
            <div className="space-y-2.5 rounded-md border bg-muted/30 p-3 text-sm">
              <p className="flex items-start gap-3">
                <User className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />{" "}
                <span>
                  <strong>Name:</strong> {customerInfo.name || "N/A"}
                </span>
              </p>
              <p className="flex items-start gap-3">
                <Phone className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />{" "}
                <span>
                  <strong>Phone:</strong>{" "}
                  {(checkout.customerPhone || customerInfo.phone) ? formatPhoneForDisplay(checkout.customerPhone || customerInfo.phone || "") : "N/A"}
                </span>
              </p>
              <p className="flex items-start gap-3">
                <MapPin className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />{" "}
                <span>
                  <strong>Address:</strong> {customerInfo.address || "N/A"}
                </span>
              </p>
              {customerInfo.location && (
                <p className="flex items-start gap-3">
                  <MapPin className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />{" "}
                  <span>
                    <strong>Location:</strong> {customerInfo.location}
                  </span>
                </p>
              )}
              {customerInfo.email && (
                <p className="flex items-start gap-3">
                  <Mail className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />{" "}
                  <span className="break-all">
                    <strong>Email:</strong> {customerInfo.email}
                  </span>
                </p>
              )}
              {customerInfo.notes && (
                <p className="flex items-start gap-3">
                  <MessageSquareText className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />{" "}
                  <span>
                    <strong>Notes:</strong> {customerInfo.notes}
                  </span>
                </p>
              )}
            </div>
          </div>
          <div className="space-y-4">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <ShoppingCart className="h-5 w-5 text-primary" /> Cart Items (
              {items.length})
            </h3>
            <div className="space-y-2">
              {items.length > 0 ? (
                items.map((item: AbandonedCheckoutCartItem, index) => (
                  <div
                    key={`${item.id}:${item.variantId ?? index}`}
                    className="flex justify-between items-center bg-muted/50 p-3 rounded-lg border"
                  >
                    <div className="flex items-center gap-3">
                      <div className="bg-muted p-2 rounded-md border">
                        <Package className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="font-semibold">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Qty: {item.quantity} &times;{" "}
                          {formatCurrency(item.price, symbol)}
                        </p>
                        {item.options && item.options.length > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.options.map((option) => `${option.name}: ${option.value}`).join(" · ")}
                          </p>
                        )}
                      </div>
                    </div>
                    <p className="font-mono text-sm font-semibold" title="Saved cart estimate; checkout will revalidate price and availability">
                      {formatCurrency(item.price * item.quantity, symbol)}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground text-sm text-center py-8">
                  No items in cart.
                </p>
              )}
            </div>
            {items.length > 0 && (
              <div className="flex justify-between font-bold text-lg border-t pt-3 mt-3">
                <span>Saved cart estimate</span>
                <span>{formatCurrency(total, symbol)}</span>
              </div>
            )}
          </div>
        </div>
        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export function AbandonedCheckoutsManager({
  routeState,
  onRouteStateChange,
}: {
  routeState: AbandonedCheckoutRouteState;
  onRouteStateChange: (
    updates: Partial<AbandonedCheckoutRouteState>,
    options?: { replace?: boolean },
  ) => void;
}) {
  useCurrency();
  const queryClient = useQueryClient();
  const orderActions = useOrderActionPermissions();

  // Local UI state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteDialog, setDeleteDialog] = useState<{ ids: string[] } | null>(
    null,
  );
  const [detailsDialog, setDetailsDialog] = useState<AbandonedCheckout | null>(
    null,
  );
  const [isActionLoading, setIsActionLoading] = useState(false);

  // TanStack Query for data fetching
  const {
    data: rawData,
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useQuery({
    ...abandonedCheckoutsQueryOptions(
      abandonedCheckoutRouteStateToQuery(routeState),
    ),
    placeholderData: keepPreviousData,
  });

  // Extract typed data
  const { checkouts, pagination } = useMemo(() => {
    const raw = rawData as Record<string, unknown> | undefined;
    if (!raw) {
      return {
        checkouts: [] as AbandonedCheckout[],
        pagination: { page: 1, limit: routeState.limit, total: 0, totalPages: 1 } as Pagination,
      };
    }
    return {
      checkouts: (raw.checkouts ?? []) as AbandonedCheckout[],
      pagination: (raw.pagination ?? { page: 1, limit: routeState.limit, total: 0, totalPages: 1 }) as Pagination,
    };
  }, [rawData, routeState.limit]);

  const deleteDialogHostedArchiveCount = useMemo(() => {
    if (!deleteDialog) return 0;
    const ids = new Set(deleteDialog.ids);
    return checkouts.filter((checkout) =>
      ids.has(checkout.id)
      && parseAbandonedCheckoutDisplay(checkout).kind === "stale_hosted_payment_order"
    ).length;
  }, [checkouts, deleteDialog]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [
    routeState.limit,
    routeState.order,
    routeState.page,
    routeState.search,
    routeState.sort,
  ]);

  useEffect(() => {
    if (!rawData) return;
    const canonicalPage = getCanonicalPageForPagination(routeState.page, pagination);
    if (canonicalPage !== routeState.page) {
      onRouteStateChange({ page: canonicalPage }, { replace: true });
    }
  }, [onRouteStateChange, pagination, rawData, routeState.page]);

  const handlePageChange = useCallback((newPage: number) => {
    onRouteStateChange({ page: newPage });
  }, [onRouteStateChange]);

  const handleLimitChange = useCallback((newLimit: number) => {
    onRouteStateChange({ limit: newLimit, page: 1 });
  }, [onRouteStateChange]);

  const handleSort = useCallback((key: AbandonedCheckoutSort) => {
    onRouteStateChange({
      sort: key,
      order:
        routeState.sort === key && routeState.order === "desc" ? "asc" : "desc",
      page: 1,
    });
  }, [onRouteStateChange, routeState.order, routeState.sort]);

  const handleSearchChange = useCallback((search: string) => {
    onRouteStateChange({ search, page: 1 }, { replace: true });
  }, [onRouteStateChange]);

  const handleToggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  }, []);

  const handleToggleSelectAll = useCallback((checked: boolean | "indeterminate") => {
    if (checked) {
      setSelectedIds(new Set(checkouts.map((c) => c.id)));
    } else {
      setSelectedIds(new Set());
    }
  }, [checkouts]);

  const performDelete = useCallback(async () => {
    if (!deleteDialog) return;
    if (!orderActions.canDeleteOrders) {
      toast.error("Delete unavailable", {
        description: "Your role can view incomplete orders but cannot delete them.",
      });
      setDeleteDialog(null);
      return;
    }
    setIsActionLoading(true);
    try {
      await deleteAbandonedCheckouts({ data: { ids: deleteDialog.ids } });
      toast.success(`${formatAbandonedCheckoutRecordCount(deleteDialog.ids.length)} deleted.`);
      setSelectedIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ["abandoned-checkouts"] });
    } catch {
      toast.error("Deletion failed.");
    } finally {
      setIsActionLoading(false);
      setDeleteDialog(null);
    }
  }, [deleteDialog, orderActions.canDeleteOrders, queryClient]);

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  const renderSortArrow = (key: AbandonedCheckoutSort) => {
    if (routeState.sort !== key)
      return <ArrowUpDown className="ml-2 h-3 w-3 text-muted-foreground/50" />;
    return routeState.order === "desc" ? (
      <span className="ml-1 text-foreground">&#9660;</span>
    ) : (
      <span className="ml-1 text-foreground">&#9650;</span>
    );
  };

  return (
    <>
      <div className="space-y-3">
        <DataTableToolbar
          searchValue={routeState.search}
          onSearchChange={handleSearchChange}
          searchPlaceholder="Search customer, phone, ID, or item…"
          selectedCount={selectedIds.size}
          filters={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2 text-xs md:hidden"
              onClick={() => handleSort("updatedAt")}
              aria-label={`Sort by last updated, currently ${routeState.order === "desc" ? "newest first" : "oldest first"}`}
            >
              <ArrowUpDown className="mr-1 h-3.5 w-3.5" />
              {routeState.order === "desc" ? "Newest" : "Oldest"}
            </Button>
          }
          bulkActions={
            orderActions.canBulkDeleteOrders ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={() =>
                  setDeleteDialog({ ids: Array.from(selectedIds) })
                }
                disabled={isActionLoading}
              >
                <Trash2 className="h-4 w-4 mr-2" /> Delete ({selectedIds.size})
              </Button>
            ) : null
          }
          actions={
            <Button
              onClick={refresh}
              disabled={isFetching}
              variant="outline"
              size="sm"
            >
              {isFetching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Refresh
            </Button>
          }
        />

        {isError ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
            <p className="min-w-0 flex-1 text-muted-foreground">
              {checkouts.length > 0
                ? "The latest incomplete checkouts could not be loaded. Showing the last available result."
                : "Incomplete checkouts could not be loaded. No records have been assumed."}
            </p>
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : null}

        <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <Info className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Recovery context for active checkouts and archived hosted payments.
            <span className="hidden sm:inline"> Empty sessions clear after 1 hour; all sessions clear after 30 days.</span>
          </p>
        </div>

        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="relative">
              {isFetching && checkouts.length > 0 && (
                <div className="absolute inset-0 bg-background/50 backdrop-blur-[1px] z-10" />
              )}
              <div className="md:hidden">
                {isLoading ? (
                  <div className="grid h-52 place-items-center">
                    <Loader2 className="h-7 w-7 animate-spin text-primary" />
                  </div>
                ) : isError && checkouts.length === 0 ? (
                  <div className="flex h-52 flex-col items-center justify-center gap-2 px-5 text-center text-muted-foreground">
                    <AlertCircle className="h-9 w-9 text-destructive" />
                    <p className="font-medium text-foreground">Incomplete checkouts unavailable</p>
                    <p className="text-xs">Try again without losing this search or sort.</p>
                  </div>
                ) : checkouts.length === 0 ? (
                  <div className="flex h-52 flex-col items-center justify-center gap-2 px-5 text-center text-muted-foreground">
                    <ShoppingCart className="h-9 w-9" />
                    <p className="font-medium">No incomplete orders found.</p>
                    <p className="text-xs">Change the search or check back after more checkout activity.</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between border-b bg-muted/20 px-3 py-2 text-xs">
                      {orderActions.canBulkDeleteOrders ? (
                        <label className="flex cursor-pointer items-center gap-2 font-medium">
                          <Checkbox
                            onCheckedChange={handleToggleSelectAll}
                            checked={selectedIds.size === checkouts.length}
                            aria-label="Select all incomplete checkouts on this page"
                          />
                          Select page
                        </label>
                      ) : <span />}
                      <span className="text-muted-foreground">{checkouts.length} on this page</span>
                    </div>
                    <div>
                      {checkouts.map((checkout) => (
                        <CheckoutCard
                          key={checkout.id}
                          checkout={checkout}
                          isSelected={selectedIds.has(checkout.id)}
                          onToggleSelection={handleToggleSelection}
                          onViewDetails={setDetailsDialog}
                          onDelete={(id) => setDeleteDialog({ ids: [id] })}
                          canDelete={orderActions.canDeleteOrders}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      {orderActions.canBulkDeleteOrders && (
                        <Checkbox
                          onCheckedChange={handleToggleSelectAll}
                          checked={
                            checkouts.length > 0 &&
                            selectedIds.size === checkouts.length
                          }
                          aria-label="Select all incomplete checkouts on this page"
                        />
                      )}
                    </TableHead>
                    <TableHead>
                      <button
                        type="button"
                        className="flex items-center font-medium hover:text-foreground"
                        onClick={() => handleSort("checkoutId")}
                      >
                        ID {renderSortArrow("checkoutId")}
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        type="button"
                        className="flex items-center font-medium hover:text-foreground"
                        onClick={() => handleSort("customerPhone")}
                      >
                        Customer {renderSortArrow("customerPhone")}
                      </button>
                    </TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Saved cart</TableHead>
                    <TableHead>
                      <button
                        type="button"
                        className="flex items-center font-medium hover:text-foreground"
                        onClick={() => handleSort("updatedAt")}
                      >
                        Last updated {renderSortArrow("updatedAt")}
                      </button>
                    </TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                  </TableHeader>
                  <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="h-64 text-center">
                        <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
                      </TableCell>
                    </TableRow>
                  ) : isError && checkouts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="h-64 text-center text-muted-foreground">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <AlertCircle className="h-9 w-9 text-destructive" />
                          <p className="font-medium text-foreground">Incomplete checkouts unavailable</p>
                          <p className="text-xs">Try again without losing this search or sort.</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : checkouts.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="h-64 text-center text-muted-foreground"
                      >
                        <div className="flex flex-col items-center justify-center gap-2">
                          <ShoppingCart className="h-10 w-10" />
                          <p className="font-medium">
                            No incomplete orders found.
                          </p>
                          <p className="text-xs">
                            Change the search or check back after more checkout activity.
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    checkouts.map((checkout) => (
                      <CheckoutRow
                        key={checkout.id}
                        checkout={checkout}
                        isSelected={selectedIds.has(checkout.id)}
                        onToggleSelection={handleToggleSelection}
                        onViewDetails={setDetailsDialog}
                        onDelete={(id) => setDeleteDialog({ ids: [id] })}
                        canDelete={orderActions.canDeleteOrders}
                      />
                    ))
                  )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </CardContent>
          {pagination.totalPages > 1 && (
            <div className="p-4 pt-2">
              <AdminListPagination
                pagination={pagination}
                itemLabel="checkouts"
                onPageChange={handlePageChange}
                onLimitChange={handleLimitChange}
                pageSizeOptions={[10, 20, 50, 100]}
              />
            </div>
          )}
        </Card>
      </div>

      <AlertDialog
        open={!!deleteDialog}
        onOpenChange={() => setDeleteDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete checkout records?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {formatAbandonedCheckoutRecordCount(deleteDialog?.ids.length ?? 0)},
              including any archived hosted-payment recovery
              context in the selection. This action cannot be undone.
              {deleteDialogHostedArchiveCount > 0 && (
                <span className="mt-3 block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                  {deleteDialogHostedArchiveCount} archived hosted-payment record
                  {deleteDialogHostedArchiveCount === 1 ? "" : "s"} will be removed from
                  this recovery list. The original order record remains in Orders.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={performDelete}
              className={cn("bg-destructive hover:bg-destructive/90")}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DetailsModal
        checkout={detailsDialog}
        onClose={() => setDetailsDialog(null)}
      />
    </>
  );
}
