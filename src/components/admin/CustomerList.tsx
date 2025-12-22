// src/components/admin/CustomerList.tsx
import React, { useMemo, useState, useEffect, useCallback } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  ExternalLink,
  Loader2,
  Mail,
  MapPin,
  MoreHorizontal,
  Pencil,
  Phone,
  Search,
  ShoppingBag,
  Trash2,
  Undo,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";

interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  address: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  cityName?: string;
  zoneName?: string;
  areaName?: string | null;
}

interface CustomerListProps {
  customers: Customer[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  initialSearchQuery?: string;
  initialSort?: {
    field:
      | "name"
      | "totalOrders"
      | "totalSpent"
      | "lastOrderAt"
      | "createdAt"
      | "updatedAt";
    order: "asc" | "desc";
  };
  showTrashed?: boolean;
}

type SortField = NonNullable<CustomerListProps["initialSort"]>["field"];

export function CustomerList({
  customers: initialCustomers,
  pagination: initialPagination,
  initialSearchQuery = "",
  initialSort = { field: "updatedAt", order: "desc" },
  showTrashed = false,
}: CustomerListProps) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [sort, setSort] = useState(initialSort);
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(
    new Set(),
  );
  const [dialogState, setDialogState] = useState<
    { action: "delete" | "bulk-delete"; id?: string } | undefined
  >();
  const [isProcessing, setIsProcessing] = useState(false);

  const [displayCustomers, setDisplayCustomers] = useState<Customer[]>(
    initialCustomers || [],
  );
  const [currentPagination, setCurrentPagination] = useState(initialPagination);

  useEffect(() => {
    setDisplayCustomers(initialCustomers || []);
  }, [initialCustomers]);

  useEffect(() => {
    setCurrentPagination(initialPagination);
  }, [initialPagination]);

  useEffect(() => {
    const url = new URL(window.location.href);
    setSort({
      field: (url.searchParams.get("sort") || initialSort.field) as SortField,
      order: (url.searchParams.get("order") || initialSort.order) as
        | "asc"
        | "desc",
    });
    setSearchQuery(url.searchParams.get("search") || initialSearchQuery);
  }, [initialSort, initialSearchQuery]);

  const updateUrlParams = useCallback(
    (params: Record<string, string | null>) => {
      const url = new URL(window.location.href);
      for (const key in params) {
        const value = params[key];
        if (value) {
          url.searchParams.set(key, value);
        } else {
          url.searchParams.delete(key);
        }
      }
      window.location.href = url.toString();
    },
    [],
  );

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      updateUrlParams({ search: searchQuery.trim(), page: null });
    },
    [searchQuery, updateUrlParams],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newOrder =
        sort.field === field && sort.order === "asc" ? "desc" : "asc";
      updateUrlParams({ sort: field, order: newOrder });
    },
    [sort, updateUrlParams],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > currentPagination.totalPages) return;
      updateUrlParams({ page: newPage.toString() });
    },
    [currentPagination.totalPages, updateUrlParams],
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      updateUrlParams({ limit: newLimit.toString(), page: null });
    },
    [updateUrlParams],
  );

  const toggleTrashView = useCallback(() => {
    updateUrlParams({ trashed: showTrashed ? null : "true", page: null });
  }, [showTrashed, updateUrlParams]);

  const performApiAction = useCallback(
    async (
      action: () => Promise<Response>,
      {
        successTitle,
        successDescription,
        errorTitle,
        optimisticUpdate,
      }: {
        successTitle: string;
        successDescription: string;
        errorTitle: string;
        optimisticUpdate: () => void;
      },
    ) => {
      setIsProcessing(true);
      try {
        const response = await action();
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "An unknown error occurred.");
        }
        optimisticUpdate();
        setSelectedCustomers(new Set());
        toast({ title: successTitle, description: successDescription });
      } catch (error) {
        console.error(`${errorTitle}:`, error);
        toast({
          title: errorTitle,
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      } finally {
        setIsProcessing(false);
        setDialogState(undefined);
      }
    },
    [toast],
  );

  const handleDelete = (id: string) => {
    performApiAction(
      () => fetch(`/api/customers/${id}`, { method: "DELETE" }),
      {
        successTitle: "Customer Moved to Trash",
        successDescription: "The customer record has been moved to the trash.",
        errorTitle: "Failed to Trash Customer",
        optimisticUpdate: () => {
          setDisplayCustomers((prev) => prev.filter((c) => c.id !== id));
          setCurrentPagination((prev) => ({
            ...prev,
            total: Math.max(0, prev.total - 1),
          }));
        },
      },
    );
  };

  const handlePermanentDelete = (id: string) => {
    performApiAction(
      () => fetch(`/api/customers/${id}/permanent`, { method: "DELETE" }),
      {
        successTitle: "Customer Permanently Deleted",
        successDescription: "The customer record has been permanently removed.",
        errorTitle: "Deletion Failed",
        optimisticUpdate: () => {
          setDisplayCustomers((prev) => prev.filter((c) => c.id !== id));
          setCurrentPagination((prev) => ({
            ...prev,
            total: Math.max(0, prev.total - 1),
          }));
        },
      },
    );
  };

  const handleRestore = (id: string) => {
    performApiAction(
      () => fetch(`/api/customers/${id}/restore`, { method: "POST" }),
      {
        successTitle: "Customer Restored",
        successDescription: "The customer has been successfully restored.",
        errorTitle: "Restore Failed",
        optimisticUpdate: () => {
          setDisplayCustomers((prev) => prev.filter((c) => c.id !== id));
          setCurrentPagination((prev) => ({
            ...prev,
            total: Math.max(0, prev.total - 1),
          }));
        },
      },
    );
  };

  const handleBulkAction = () => {
    const ids = Array.from(selectedCustomers);
    performApiAction(
      () =>
        fetch("/api/customers/bulk-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerIds: ids, permanent: showTrashed }),
        }),
      {
        successTitle: "Bulk Action Successful",
        successDescription: `${ids.length} customers have been ${showTrashed ? "permanently deleted" : "moved to trash"}.`,
        errorTitle: "Bulk Action Failed",
        optimisticUpdate: () => {
          setDisplayCustomers((prev) =>
            prev.filter((c) => !ids.includes(c.id)),
          );
          setCurrentPagination((prev) => ({
            ...prev,
            total: Math.max(0, prev.total - ids.length),
          }));
        },
      },
    );
  };

  const toggleCustomerSelection = useCallback((id: string) => {
    setSelectedCustomers((prev) => {
      const newSelection = new Set(prev);
      newSelection.has(id) ? newSelection.delete(id) : newSelection.add(id);
      return newSelection;
    });
  }, []);

  const toggleAllCustomers = useCallback(() => {
    if (
      selectedCustomers.size === displayCustomers.length &&
      displayCustomers.length > 0
    ) {
      setSelectedCustomers(new Set());
    } else {
      setSelectedCustomers(new Set(displayCustomers.map((c) => c.id)));
    }
  }, [displayCustomers, selectedCustomers.size]);

  const selectAllCheckedState = useMemo(
    () =>
      displayCustomers.length > 0 &&
      (selectedCustomers.size === displayCustomers.length
        ? true
        : selectedCustomers.size > 0
          ? "indeterminate"
          : false),
    [selectedCustomers.size, displayCustomers.length],
  );

  const getSortIcon = useCallback(
    (field: SortField) => {
      if (sort.field !== field)
        return (
          <ArrowUpDown className="ml-1.5 h-3 w-3 text-muted-foreground/70" />
        );
      return sort.order === "asc" ? (
        <ArrowUp className="ml-1.5 h-3 w-3" />
      ) : (
        <ArrowDown className="ml-1.5 h-3 w-3" />
      );
    },
    [sort],
  );

  const formatDate = useCallback(
    (date: Date | null) =>
      date
        ? new Date(date).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "—",
    [],
  );

  const formatLocation = useCallback((customer: Customer) => {
    // Prioritize names, fall back to IDs only if no name is available (though ideally IDs shouldn't be shown to users)
    // Actually, let's strictly show names. If a name is missing but ID exists, we might prefer "Unknown City" or just skip it
    // to avoid showing ugly IDs like "tsnu3..."
    const parts = [
      customer.address,
      customer.areaName, // Use the enriched names
      customer.zoneName,
      customer.cityName,
    ].filter(Boolean);

    return parts.length > 0 ? parts.join(", ") : "—";
  }, []);

  const renderEmptyState = () => (
    <TableRow>
      <TableCell colSpan={6} className="h-48 text-center">
        <div className="flex flex-col items-center justify-center gap-2">
          <Users className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-lg font-medium text-muted-foreground">
            {searchQuery
              ? "No Customers Match Your Search"
              : showTrashed
                ? "Trash is Empty"
                : "No Customers Found"}
          </p>
          <p className="text-sm text-muted-foreground">
            {searchQuery
              ? "Try adjusting your search query."
              : showTrashed
                ? "Deleted customer records will appear here."
                : "Add a new customer or sync from your orders."}
          </p>
          <div className="flex gap-2 mt-2">
            <Button size="sm" asChild>
              <a href="/admin/customers/new">
                <UserPlus className="mr-2 h-4 w-4" /> Add Customer
              </a>
            </Button>
          </div>
        </div>
      </TableCell>
    </TableRow>
  );

  return (
    <>
      <Card>
        <CardHeader className="p-4 border-b">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-xl flex items-center gap-2">
                {showTrashed ? "Trash" : "Customers"}
                <Badge variant="secondary">{currentPagination.total}</Badge>
              </CardTitle>
              <CardDescription className="mt-1">
                {showTrashed
                  ? "Review and manage deleted customer records."
                  : "Browse, manage, and view your customer database."}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={toggleTrashView}>
                {showTrashed ? (
                  <Users className="h-4 w-4" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                <span className="sr-only sm:not-sr-only sm:ml-2">
                  {showTrashed ? "Active" : "Trash"}
                </span>
              </Button>
              {!showTrashed && (
                <Button size="sm" asChild>
                  <a href="/admin/customers/new">
                    <UserPlus className="h-4 w-4" />
                    <span className="sr-only sm:not-sr-only sm:ml-2">
                      Add New
                    </span>
                  </a>
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <div className="p-4 flex items-center justify-between gap-4 bg-muted/20">
          <form onSubmit={handleSearch} className="flex-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search by name, phone, or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 w-full max-w-md"
              />
            </div>
          </form>
          {selectedCustomers.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {selectedCustomers.size} selected
              </span>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive hover:bg-destructive/10"
                onClick={() => setDialogState({ action: "bulk-delete" })}
                disabled={isProcessing}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {showTrashed ? "Delete" : "Trash"} All
              </Button>
            </div>
          )}
        </div>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-12 px-4">
                    <Checkbox
                      checked={selectAllCheckedState}
                      onCheckedChange={toggleAllCustomers}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead className="min-w-[250px]">
                    <Button
                      variant="ghost"
                      className="px-1 -ml-1"
                      onClick={() => handleSort("name")}
                    >
                      Customer {getSortIcon("name")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      className="px-1 -ml-1"
                      onClick={() => handleSort("totalOrders")}
                    >
                      Orders {getSortIcon("totalOrders")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      className="px-1 -ml-1"
                      onClick={() => handleSort("totalSpent")}
                    >
                      Total Spent {getSortIcon("totalSpent")}
                    </Button>
                  </TableHead>
                  <TableHead>
                    <Button
                      variant="ghost"
                      className="px-1 -ml-1"
                      onClick={() => handleSort("lastOrderAt")}
                    >
                      Last Order {getSortIcon("lastOrderAt")}
                    </Button>
                  </TableHead>
                  <TableHead className="w-[80px] text-right pr-4">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayCustomers.length === 0
                  ? renderEmptyState()
                  : displayCustomers.map((customer) => (
                      <TableRow
                        key={customer.id}
                        data-state={
                          selectedCustomers.has(customer.id)
                            ? "selected"
                            : undefined
                        }
                      >
                        <TableCell className="px-4">
                          <Checkbox
                            checked={selectedCustomers.has(customer.id)}
                            onCheckedChange={() =>
                              toggleCustomerSelection(customer.id)
                            }
                            aria-label={`Select ${customer.name}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <a
                              href={`/admin/customers/${customer.id}/history`}
                              className="text-primary hover:underline flex items-center gap-1.5 w-fit"
                            >
                              {customer.name}
                              <ExternalLink className="h-3.5 w-3.5 opacity-50" />
                            </a>
                            <div className="text-xs text-muted-foreground mt-1 space-y-1">
                              <div className="flex items-center gap-2">
                                <Phone className="h-3 w-3" />
                                <span>{customer.phone}</span>
                              </div>
                              {customer.email && (
                                <div className="flex items-center gap-2">
                                  <Mail className="h-3 w-3" />
                                  <span>{customer.email}</span>
                                </div>
                              )}
                              {formatLocation(customer) && (
                                <div className="flex items-start gap-2">
                                  <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                                  <span className="line-clamp-1">
                                    {formatLocation(customer)}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-sm">
                            <ShoppingBag className="h-4 w-4 text-muted-foreground" />
                            {customer.totalOrders}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-sm">
                            <span className="text-muted-foreground">৳</span>
                            {customer.totalSpent.toLocaleString()}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Clock className="h-4 w-4" />
                            {formatDate(customer.lastOrderAt)}
                          </div>
                        </TableCell>
                        <TableCell className="text-right pr-4">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                                <span className="sr-only">Actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className="w-[180px]"
                            >
                              {showTrashed ? (
                                <>
                                  <DropdownMenuItem
                                    onClick={() => handleRestore(customer.id)}
                                    disabled={isProcessing}
                                  >
                                    <Undo className="mr-2 h-4 w-4" />
                                    <span>Restore Customer</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onClick={() =>
                                      setDialogState({
                                        action: "delete",
                                        id: customer.id,
                                      })
                                    }
                                    disabled={isProcessing}
                                  >
                                    <XCircle className="mr-2 h-4 w-4" />
                                    <span>Delete Permanently</span>
                                  </DropdownMenuItem>
                                </>
                              ) : (
                                <>
                                  <DropdownMenuItem asChild>
                                    <a
                                      href={`/admin/customers/${customer.id}/edit`}
                                    >
                                      <Pencil className="mr-2 h-4 w-4" />
                                      Edit Customer
                                    </a>
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onClick={() =>
                                      setDialogState({
                                        action: "delete",
                                        id: customer.id,
                                      })
                                    }
                                    disabled={isProcessing}
                                  >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    <span>Move to Trash</span>
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
        {currentPagination.totalPages > 1 && (
          <CardHeader className="p-4 border-t flex-row items-center justify-between gap-4">
            <div className="text-sm text-muted-foreground">
              {selectedCustomers.size > 0
                ? `${selectedCustomers.size} of ${currentPagination.total} selected`
                : `Page ${currentPagination.page} of ${currentPagination.totalPages}`}
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    Rows: {currentPagination.limit}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {[10, 20, 50, 100].map((size) => (
                    <DropdownMenuItem
                      key={size}
                      onClick={() => handleLimitChange(size)}
                    >
                      {size}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 hidden lg:flex"
                  onClick={() => handlePageChange(1)}
                  disabled={currentPagination.page === 1}
                >
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handlePageChange(currentPagination.page - 1)}
                  disabled={currentPagination.page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handlePageChange(currentPagination.page + 1)}
                  disabled={
                    currentPagination.page >= currentPagination.totalPages
                  }
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 hidden lg:flex"
                  onClick={() => handlePageChange(currentPagination.totalPages)}
                  disabled={
                    currentPagination.page >= currentPagination.totalPages
                  }
                >
                  <ChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
        )}
      </Card>
      <AlertDialog
        open={!!dialogState}
        onOpenChange={(open) => !open && setDialogState(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle
                className={cn(
                  "h-6 w-6",
                  showTrashed ? "text-destructive" : "text-amber-500",
                )}
              />
              {showTrashed ? "Permanently Delete?" : "Move to Trash?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialogState?.action === "bulk-delete"
                ? `You are about to ${showTrashed ? "permanently delete" : "move to trash"} ${selectedCustomers.size} customer(s).`
                : "This action will affect the selected customer record."}
              {showTrashed && (
                <span className="font-semibold text-destructive block mt-2">
                  This action is irreversible.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                showTrashed && "bg-destructive hover:bg-destructive/90",
              )}
              disabled={isProcessing}
              onClick={() => {
                if (dialogState?.action === "bulk-delete") handleBulkAction();
                else if (dialogState?.id) {
                  showTrashed
                    ? handlePermanentDelete(dialogState.id)
                    : handleDelete(dialogState.id);
                }
              }}
            >
              {isProcessing && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
