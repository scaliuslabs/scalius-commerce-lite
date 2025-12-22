import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AbandonedCheckout } from "@/db/schema";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "../ui/pagination";

// --- Type Definitions ---
interface CartItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  [key: string]: any; // Allow other properties
}

interface CustomerInfo {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  email?: string | null;
}

interface ParsedCheckoutData {
  items: CartItem[];
  customerInfo: CustomerInfo;
  total: number;
}

type SortKey = keyof AbandonedCheckout;

// --- Utility Functions ---

const formatCurrency = (amount: number) => {
  return `৳${amount.toFixed(2)}`;
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

const parseCheckoutData = (checkoutDataString: string): ParsedCheckoutData => {
  try {
    const data = JSON.parse(checkoutDataString);

    const items: CartItem[] =
      data.cart && Array.isArray(data.cart.items) ? data.cart.items : [];
    const total =
      data.cart && typeof data.cart.totalAmount === "number"
        ? data.cart.totalAmount
        : 0;

    const customerInfo: CustomerInfo = {
      name: data.customerName || null,
      phone: data.customerPhone || null,
      address: data.shippingAddress || null,
      notes: data.notes || null,
    };

    return { items, customerInfo, total };
  } catch {
    return { items: [], customerInfo: {}, total: 0 };
  }
};

const getCheckoutStage = (
  checkout: AbandonedCheckout,
): { stage: string; variant: "secondary" | "outline" | "default" } => {
  const { customerInfo } = parseCheckoutData(checkout.checkoutData);
  const hasCustomerInfo =
    checkout.customerPhone || Object.values(customerInfo).some((v) => !!v);
  if (hasCustomerInfo) {
    return { stage: "Info Captured", variant: "default" };
  }
  const { items } = parseCheckoutData(checkout.checkoutData);
  if (items.length > 0) {
    return { stage: "Cart Started", variant: "secondary" };
  }
  return { stage: "Session Created", variant: "outline" };
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
    const { stage, variant } = getCheckoutStage(checkout);
    const { items, total } = useMemo(
      () => parseCheckoutData(checkout.checkoutData),
      [checkout.checkoutData],
    );
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
          />
        </TableCell>
        <TableCell className="font-mono text-xs">
          {checkout.checkoutId.substring(0, 12)}
        </TableCell>
        <TableCell className="font-medium">
          {checkout.customerPhone || (
            <span className="text-muted-foreground">No phone</span>
          )}
        </TableCell>
        <TableCell>
          <Badge variant={variant}>{stage}</Badge>
        </TableCell>
        <TableCell>
          {items.length} item(s) / {formatCurrency(total)}
        </TableCell>
        <TableCell className="text-muted-foreground">
          {timeSince(updatedAt)}
        </TableCell>
        <TableCell className="text-right">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onViewDetails(checkout)}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(checkout.id)}
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
  if (!checkout) return null;

  const { items, total, customerInfo } = parseCheckoutData(
    checkout.checkoutData,
  );

  return (
    <Dialog open={!!checkout} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Checkout Details</DialogTitle>
          <DialogDescription>
            Full data for checkout{" "}
            <span className="font-mono text-xs">{checkout.checkoutId}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="grid md:grid-cols-2 gap-x-8 gap-y-6 py-4 max-h-[60vh] overflow-y-auto p-2">
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
                  {checkout.customerPhone || customerInfo.phone || "N/A"}
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
                items.map((item: CartItem) => (
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
                          {formatCurrency(item.price)}
                        </p>
                      </div>
                    </div>
                    <p className="font-mono text-sm font-semibold">
                      {formatCurrency(item.price * item.quantity)}
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
                <span>{formatCurrency(total)}</span>
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
  const [checkouts, setCheckouts] = useState<AbandonedCheckout[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isActionLoading, setIsActionLoading] = useState(false);
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

  const debouncedSearch = useDebounce(searchQuery, 300);

  const fetchCheckouts = useCallback(
    async (pageNumber: number) => {
      setIsLoading(true);
      const params = new URLSearchParams({
        page: String(pageNumber),
        limit: String(pagination.limit),
        search: debouncedSearch,
        sort: sort.key,
        order: sort.order,
      });

      try {
        const response = await fetch(
          `/api/admin/abandoned-checkouts?${params.toString()}`,
          {
            credentials: "include",
          },
        );
        if (!response.ok) {
          const errorData = await response
            .json()
            .catch(() => ({
              message: "Authentication required to access this endpoint",
            }));
          throw new Error(errorData.message || "Failed to fetch data");
        }
        const data = await response.json();
        setCheckouts(data.data);
        setPagination(data.pagination);
        setSelectedIds(new Set());
      } catch (error: any) {
        toast.error("Failed to load checkouts", { description: error.message });
      } finally {
        setIsLoading(false);
      }
    },
    [pagination.limit, debouncedSearch, sort.key, sort.order],
  );

  useEffect(() => {
    fetchCheckouts(1);
  }, [debouncedSearch, sort, pagination.limit]);

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > pagination.totalPages) return;
    setPagination((p) => ({ ...p, page: newPage }));
    fetchCheckouts(newPage);
  };

  const handleSort = (key: SortKey) => {
    setSort((prev) => ({
      key,
      order: prev.key === key && prev.order === "desc" ? "asc" : "desc",
    }));
  };

  const handleToggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  };

  const handleToggleSelectAll = (checked: boolean | "indeterminate") => {
    if (checked) {
      setSelectedIds(new Set(checkouts.map((c) => c.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const performDelete = async () => {
    if (!deleteDialog) return;
    setIsActionLoading(true);
    try {
      const response = await fetch("/api/admin/abandoned-checkouts", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: deleteDialog.ids }),
      });
      if (!response.ok) throw new Error("Failed to delete checkouts");
      toast.success(`${deleteDialog.ids.length} checkout(s) deleted.`);
      fetchCheckouts(1);
    } catch (error) {
      toast.error("Deletion failed.");
    } finally {
      setIsActionLoading(false);
      setDeleteDialog(null);
    }
  };

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
              className="pl-8"
            />
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
              onClick={() => fetchCheckouts(pagination.page)}
              disabled={isLoading}
              variant="outline"
            >
              {isLoading ? (
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
            <div className="border rounded-lg overflow-hidden">
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
            <CardHeader>
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handlePageChange(pagination.page - 1)}
                      disabled={pagination.page <= 1}
                    >
                      Previous
                    </Button>
                  </PaginationItem>
                  <PaginationItem>
                    <span className="text-sm font-medium p-2">
                      Page {pagination.page} of {pagination.totalPages}
                    </span>
                  </PaginationItem>
                  <PaginationItem>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handlePageChange(pagination.page + 1)}
                      disabled={pagination.page >= pagination.totalPages}
                    >
                      Next
                    </Button>
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </CardHeader>
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
