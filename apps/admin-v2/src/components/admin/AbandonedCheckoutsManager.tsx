import React, { useState, useCallback, useMemo } from "react";
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
import { Input } from "@/components/ui/input";
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
import { useDebounce } from "@/hooks/use-debounce";
import {
  RefreshCw,
  Trash2,
  Loader2,
  ShoppingCart,
  Info,
  Phone,
  User,
  Search,
  ArrowUpDown,
  Eye,
  Mail,
  MapPin,
  Package,
  X,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import type { AbandonedCheckout } from "@/types/api-responses";
import { AdminListPagination } from "@/components/admin/shared/AdminListPagination";
import { abandonedCheckoutsQueryOptions } from "@/lib/api-query-options/abandoned-checkouts";
import { deleteAbandonedCheckouts } from "@/lib/api-functions/abandoned-checkouts";
import {
  parseAbandonedCheckoutDisplay,
  type AbandonedCheckoutCartItem,
} from "@/lib/abandoned-checkout-display";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";

// --- Type Definitions ---
interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

type SortKey = keyof AbandonedCheckout;

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
  }: {
    checkout: AbandonedCheckout;
    isSelected: boolean;
    onToggleSelection: (id: string) => void;
    onViewDetails: (checkout: AbandonedCheckout) => void;
    onDelete: (id: string) => void;
  }) => {
    const { symbol } = useCurrency();
  const display = useMemo(
      () => parseAbandonedCheckoutDisplay(checkout),
      [checkout],
    );
    const displayId = getCheckoutDisplayId(checkout);
    const updatedAt = useMemo(
      () => (checkout.updatedAt ? new Date(checkout.updatedAt) : null),
      [checkout.updatedAt],
    );

    return (
      <TableRow data-state={isSelected ? "selected" : undefined}>
        <TableCell className="w-10">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelection(checkout.id)}
            aria-label={`Select incomplete order ${displayId}`}
          />
        </TableCell>
        <TableCell className="font-mono text-xs">
          {displayId.substring(0, 12)}
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
            : `${display.items.length} item(s) / ${formatCurrency(display.total, symbol)}`}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {timeSince(updatedAt)}
        </TableCell>
        <TableCell className="text-right">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onViewDetails(checkout)}
            aria-label={`View incomplete order ${displayId}`}
            title="View details"
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(checkout.id)}
            aria-label={`Delete incomplete order ${displayId}`}
            title="Delete"
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </TableCell>
      </TableRow>
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

  return (
    <Dialog open={!!checkout} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Checkout Details</DialogTitle>
          <DialogDescription>
            Full data for checkout{" "}
            <span className="font-mono text-xs">
              {getCheckoutDisplayId(checkout)}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="grid md:grid-cols-2 gap-x-8 gap-y-6 py-4 max-h-[60vh] overflow-y-auto p-2">
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
            <div className="space-y-3 text-sm p-4 bg-muted/50 rounded-lg border">
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
              <p className="flex items-start gap-3">
                <Mail className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />{" "}
                <span>
                  <strong>Notes:</strong> {customerInfo.notes || "N/A"}
                </span>
              </p>
            </div>
          </div>
          <div className="space-y-4">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <ShoppingCart className="h-5 w-5 text-primary" /> Cart Items (
              {items.length})
            </h3>
            <div className="space-y-2">
              {items.length > 0 ? (
                items.map((item: AbandonedCheckoutCartItem) => (
                  <div
                    key={item.id}
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
                      </div>
                    </div>
                    <p className="font-mono text-sm font-semibold">
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
                <span>Total</span>
                <span>{formatCurrency(total, symbol)}</span>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export function AbandonedCheckoutsManager() {
  useCurrency();
  const queryClient = useQueryClient();

  // Local UI state
  const [requestedPage, setRequestedPage] = useState(1);
  const [requestedLimit, setRequestedLimit] = useState(20);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; order: "asc" | "desc" }>({
    key: "updatedAt",
    order: "desc",
  });
  const [deleteDialog, setDeleteDialog] = useState<{ ids: string[] } | null>(
    null,
  );
  const [detailsDialog, setDetailsDialog] = useState<AbandonedCheckout | null>(
    null,
  );
  const [isActionLoading, setIsActionLoading] = useState(false);

  const debouncedSearch = useDebounce(searchQuery, 300);

  // TanStack Query for data fetching
  const { data: rawData, isLoading, isFetching } = useQuery({
    ...abandonedCheckoutsQueryOptions({
      page: requestedPage,
      limit: requestedLimit,
      search: debouncedSearch || undefined,
      sort: sort.key,
      order: sort.order,
    }),
    placeholderData: keepPreviousData,
  });

  // Extract typed data
  const { checkouts, pagination } = useMemo(() => {
    const raw = rawData as Record<string, unknown> | undefined;
    if (!raw) {
      return {
        checkouts: [] as AbandonedCheckout[],
        pagination: { page: 1, limit: requestedLimit, total: 0, totalPages: 1 } as Pagination,
      };
    }
    return {
      checkouts: (raw.checkouts ?? []) as AbandonedCheckout[],
      pagination: (raw.pagination ?? { page: 1, limit: requestedLimit, total: 0, totalPages: 1 }) as Pagination,
    };
  }, [rawData, requestedLimit]);

  // Reset selection when data changes (search/sort/page change)
  // This is handled implicitly by the query key changing

  const handlePageChange = useCallback((newPage: number) => {
    setRequestedPage(newPage);
    setSelectedIds(new Set());
  }, []);

  const handleLimitChange = useCallback((newLimit: number) => {
    setRequestedLimit(newLimit);
    setRequestedPage(1);
    setSelectedIds(new Set());
  }, []);

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => ({
      key,
      order: prev.key === key && prev.order === "desc" ? "asc" : "desc",
    }));
    setRequestedPage(1);
    setSelectedIds(new Set());
  }, []);

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
    setIsActionLoading(true);
    try {
      await deleteAbandonedCheckouts({ data: { ids: deleteDialog.ids } });
      toast.success(`${deleteDialog.ids.length} checkout(s) deleted.`);
      setSelectedIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ["abandoned-checkouts"] });
    } catch {
      toast.error("Deletion failed.");
    } finally {
      setIsActionLoading(false);
      setDeleteDialog(null);
    }
  }, [deleteDialog, queryClient]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["abandoned-checkouts"] });
  }, [queryClient]);

  const renderSortArrow = (key: SortKey) => {
    if (sort.key !== key)
      return <ArrowUpDown className="ml-2 h-3 w-3 text-muted-foreground/50" />;
    return sort.order === "desc" ? (
      <span className="ml-1 text-foreground">&#9660;</span>
    ) : (
      <span className="ml-1 text-foreground">&#9650;</span>
    );
  };

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by phone, ID, or cart items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-8"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedIds.size > 0 && (
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
            )}
            <Button
              onClick={refresh}
              disabled={isFetching}
              variant="outline"
            >
              {isFetching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Refresh
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3 p-3 bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 rounded-lg">
          <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
          <p className="text-xs text-blue-700 dark:text-blue-300">
            Showing active checkout sessions. Empty sessions older than 1 hour
            and any session older than 30 days are automatically cleared.
          </p>
        </div>

        <Card>
          <CardContent className="p-0">
            <div className="border rounded-lg overflow-hidden relative">
              {isFetching && checkouts.length > 0 && (
                <div className="absolute inset-0 bg-background/50 backdrop-blur-[1px] z-10" />
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        onCheckedChange={handleToggleSelectAll}
                        checked={
                          checkouts.length > 0 &&
                          selectedIds.size === checkouts.length
                        }
                      />
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none"
                      onClick={() => handleSort("checkoutId")}
                    >
                      ID {renderSortArrow("checkoutId")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none"
                      onClick={() => handleSort("customerPhone")}
                    >
                      Customer {renderSortArrow("customerPhone")}
                    </TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Cart</TableHead>
                    <TableHead
                      className="cursor-pointer select-none"
                      onClick={() => handleSort("updatedAt")}
                    >
                      Last Updated {renderSortArrow("updatedAt")}
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
                  ) : checkouts.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="h-64 text-center text-muted-foreground"
                      >
                        <div className="flex flex-col items-center justify-center gap-2">
                          <ShoppingCart className="h-10 w-10" />
                          <p className="font-medium">
                            No abandoned checkouts found.
                          </p>
                          <p className="text-xs">
                            Check back later or after a marketing campaign.
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
                      />
                    ))
                  )}
                </TableBody>
              </Table>
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
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {deleteDialog?.ids.length} checkout
              session(s). This action cannot be undone.
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
                "Confirm Delete"
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
