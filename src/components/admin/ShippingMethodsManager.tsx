import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  MoreHorizontal,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  Pencil,
  Plus,
  Loader2,
  AlertTriangle,
  Undo,
  Truck,
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  X,
} from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { ShippingMethod } from "@/db/schema"; // Import the type

type SortField =
  | "name"
  | "fee"
  | "isActive"
  | "sortOrder"
  | "createdAt"
  | "updatedAt";
type SortOrder = "asc" | "desc";

interface ShippingMethodsManagerProps {
  // Props will be added if we fetch initial data server-side in Astro page later
}

interface ManagerShippingMethod extends ShippingMethod {
  // Add any client-side specific fields if needed in the future
}

export function ShippingMethodsManager({}: ShippingMethodsManagerProps) {
  const { toast } = useToast();
  const [methods, setMethods] = useState<ManagerShippingMethod[]>([]);
  const [pagination, setPagination] = useState({
    total: 0,
    page: 1,
    limit: 10,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<{ field: SortField; order: SortOrder }>({
    field: "sortOrder",
    order: "asc",
  });
  const [selectedMethods, setSelectedMethods] = useState<Set<string>>(
    new Set(),
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [showTrashed, setShowTrashed] = useState(false);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingMethod, setEditingMethod] =
    useState<ManagerShippingMethod | null>(null);
  const [currentFormData, setCurrentFormData] = useState<
    Partial<ManagerShippingMethod>
  >({
    name: "",
    fee: undefined,
    description: "",
    isActive: true,
    sortOrder: undefined,
  });

  const [methodToDelete, setMethodToDelete] = useState<string | null>(null);
  const [isConfirmBulkDeleteOpen, setIsConfirmBulkDeleteOpen] = useState(false);
  const [isConfirmBulkRestoreOpen, setIsConfirmBulkRestoreOpen] =
    useState(false);

  const fetchMethods = useCallback(
    async (
      pageToFetch = pagination.page,
      limitToFetch = pagination.limit,
      currentSearch = searchQuery,
      currentSort = sort,
      currentShowTrashed = showTrashed,
    ) => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams();
        params.append("page", pageToFetch.toString());
        params.append("limit", limitToFetch.toString());
        if (currentSearch) params.append("search", currentSearch);
        params.append("sort", currentSort.field);
        params.append("order", currentSort.order);
        if (currentShowTrashed) params.append("trashed", "true");

        const response = await fetch(
          `/api/admin/settings/shipping-methods?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch shipping methods");
        const data = await response.json();

        setMethods(data.data || []);
        setPagination(
          data.pagination || {
            total: 0,
            page: 1,
            limit: 10,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        );
      } catch (error) {
        console.error("Error fetching shipping methods:", error);
        toast({
          title: "Error",
          description: "Could not load shipping methods.",
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    },
    [pagination.page, pagination.limit, searchQuery, sort, showTrashed, toast],
  );

  useEffect(() => {
    fetchMethods();
  }, [fetchMethods]); // fetchMethods is stable due to its own dependencies

  // Sync state with URL params on mount/hydration for sort and search
  useEffect(() => {
    const url = new URL(window.location.href);
    setSearchQuery(url.searchParams.get("search") || "");
    const sortFieldFromUrl = url.searchParams.get("sort") as SortField | null;
    const sortOrderFromUrl = url.searchParams.get("order") as SortOrder | null;
    if (sortFieldFromUrl && sortOrderFromUrl) {
      setSort({ field: sortFieldFromUrl, order: sortOrderFromUrl });
    }
    setShowTrashed(url.searchParams.get("trashed") === "true");
  }, []);

  const handleSearch = useCallback(
    (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      const url = new URL(window.location.href);
      if (searchQuery.trim()) {
        url.searchParams.set("search", searchQuery.trim());
      } else {
        url.searchParams.delete("search");
      }
      url.searchParams.set("page", "1"); // Reset to page 1 on search
      window.history.pushState({}, "", url.toString());
      fetchMethods(1, pagination.limit, searchQuery, sort, showTrashed);
    },
    [searchQuery, pagination.limit, sort, showTrashed, fetchMethods],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newOrder: SortOrder =
        sort.field === field && sort.order === "asc" ? "desc" : "asc";
      const newSort = { field, order: newOrder as SortOrder };
      setSort(newSort);
      const url = new URL(window.location.href);
      url.searchParams.set("sort", field);
      url.searchParams.set("order", newOrder);
      url.searchParams.set("page", "1");
      window.history.pushState({}, "", url.toString());
      fetchMethods(1, pagination.limit, searchQuery, newSort, showTrashed);
    },
    [sort, pagination.limit, searchQuery, showTrashed, fetchMethods],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > pagination.totalPages) return;
      const url = new URL(window.location.href);
      url.searchParams.set("page", newPage.toString());
      window.history.pushState({}, "", url.toString());
      fetchMethods(newPage, pagination.limit, searchQuery, sort, showTrashed);
    },
    [
      pagination.totalPages,
      pagination.limit,
      searchQuery,
      sort,
      showTrashed,
      fetchMethods,
    ],
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      const url = new URL(window.location.href);
      url.searchParams.set("limit", newLimit.toString());
      url.searchParams.set("page", "1"); // Reset to page 1 on limit change
      window.history.pushState({}, "", url.toString());
      fetchMethods(1, newLimit, searchQuery, sort, showTrashed);
    },
    [searchQuery, sort, showTrashed, fetchMethods],
  );

  const toggleTrash = useCallback(() => {
    const newShowTrashed = !showTrashed;
    setShowTrashed(newShowTrashed);
    const url = new URL(window.location.href);
    if (newShowTrashed) {
      url.searchParams.set("trashed", "true");
    } else {
      url.searchParams.delete("trashed");
    }
    url.searchParams.set("page", "1");
    window.history.pushState({}, "", url.toString());
    fetchMethods(1, pagination.limit, searchQuery, sort, newShowTrashed);
  }, [showTrashed, pagination.limit, searchQuery, sort, fetchMethods]);

  const openFormForCreate = () => {
    setEditingMethod(null);
    setCurrentFormData({
      name: "",
      fee: undefined,
      description: "",
      isActive: true,
      sortOrder: undefined,
    });
    setIsFormOpen(true);
  };

  const openFormForEdit = (method: ManagerShippingMethod) => {
    setEditingMethod(method);
    setCurrentFormData({ ...method });
    setIsFormOpen(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsActionLoading(true);
    const url = editingMethod
      ? `/api/admin/settings/shipping-methods/${editingMethod.id}`
      : "/api/admin/settings/shipping-methods";
    const method = editingMethod ? "PUT" : "POST";

    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentFormData),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error ||
            (editingMethod ? "Failed to update" : "Failed to create") +
              " shipping method",
        );
      }
      toast({
        title: "Success",
        description: `Shipping method ${editingMethod ? "updated" : "created"} successfully.`,
      });
      setIsFormOpen(false);
      fetchMethods(editingMethod ? pagination.page : 1); // Refresh list, go to page 1 on create
    } catch (error: any) {
      console.error("Form submission error:", error);
      toast({
        title: "Error",
        description: error.message || "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDelete = async (id?: string) => {
    const idToDelete = id || methodToDelete;
    if (!idToDelete) return;
    setIsActionLoading(true);
    setMethodToDelete(null); // Close dialog optimistically

    try {
      const response = await fetch(
        `/api/admin/settings/shipping-methods/${idToDelete}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok && response.status !== 204)
        throw new Error("Failed to move to trash");

      toast({
        title: "Success",
        description: "Shipping method moved to trash.",
      });
      fetchMethods(pagination.page); // Refresh
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(idToDelete);
        return next;
      });
    } catch (error) {
      console.error("Error deleting method:", error);
      toast({
        title: "Error",
        description: "Failed to move to trash.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handlePermanentDelete = async (id?: string) => {
    const idToDelete = id || methodToDelete;
    if (!idToDelete) return;
    setIsActionLoading(true);
    setMethodToDelete(null);

    try {
      // Astro/Hono does not support DELETE with body for permanent typically, use a custom endpoint or query param if needed.
      // For now, we assume DELETE on `/[id]` with `showTrashed=true` context means permanent.
      // The API for permanent delete should be distinct if DELETE `/[id]` is only for soft delete.
      // Let's assume a specific endpoint or a different API structure for permanent for now.
      // For this example, let's simulate it will be handled by the same DELETE if it were a different endpoint or logic.
      // If the `DELETE /[id]` is always soft, we need a `DELETE /[id]/permanent` or similar.
      // For now, we will call the same DELETE and expect the API to know based on context (which is not ideal)
      // OR we create a specific API call like /api/admin/settings/shipping-methods/${idToDelete}/permanent-delete
      // Let's assume the API needs a specific endpoint for permanent deletion for safety.
      // However, given the existing structure from CategoryList, we will call the same delete endpoint
      // and rely on the API to have logic for permanent if `showTrashed` is true on client,
      // which means the API for `DELETE /[id]` should check a param like `permanent=true` or be a different endpoint.
      // For simplicity in this component, we call the standard DELETE. The API needs to be robust.
      // **Correction**: CategoryList uses /api/categories/[id]/permanent. We should do the same.
      const response = await fetch(
        `/api/admin/settings/shipping-methods/${idToDelete}/permanent-delete`,
        {
          // Assuming this endpoint exists
          method: "DELETE",
        },
      );
      if (!response.ok && response.status !== 204)
        throw new Error("Failed to permanently delete method");

      toast({
        title: "Success",
        description: "Shipping method permanently deleted.",
      });
      fetchMethods(pagination.page);
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(idToDelete);
        return next;
      });
    } catch (error) {
      console.error("Error permanently deleting method:", error);
      toast({
        title: "Error",
        description: "Failed to permanently delete method.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRestore = async (id: string) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/admin/settings/shipping-methods/${id}/restore`,
        {
          method: "POST", // Or PUT, depending on API design
        },
      );
      if (!response.ok) throw new Error("Failed to restore shipping method");
      toast({
        title: "Success",
        description: "Shipping method restored successfully.",
      });
      fetchMethods(pagination.page);
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (error) {
      console.error("Error restoring method:", error);
      toast({
        title: "Error",
        description: "Failed to restore shipping method.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleBulkAction = async (
    action: "trash" | "deletePermanent" | "restore",
  ) => {
    if (selectedMethods.size === 0) return;
    setIsActionLoading(true);
    const ids = Array.from(selectedMethods);
    setIsConfirmBulkDeleteOpen(false);
    setIsConfirmBulkRestoreOpen(false);

    try {
      // This needs a new bulk API endpoint in the backend
      // For now, we will iterate and call individual APIs as a fallback (not efficient for many items)
      let successCount = 0;
      for (const id of ids) {
        let response;
        if (action === "trash") {
          response = await fetch(`/api/admin/settings/shipping-methods/${id}`, {
            method: "DELETE",
          });
        } else if (action === "deletePermanent") {
          // Needs /api/admin/settings/shipping-methods/[id]/permanent-delete or similar
          response = await fetch(
            `/api/admin/settings/shipping-methods/${id}/permanent-delete`,
            { method: "DELETE" },
          );
        } else if (action === "restore") {
          response = await fetch(
            `/api/admin/settings/shipping-methods/${id}/restore`,
            { method: "POST" },
          );
        }
        if (response && (response.ok || response.status === 204)) {
          successCount++;
        }
      }

      if (successCount > 0) {
        toast({
          title: "Success",
          description: `${successCount} of ${ids.length} methods ${action === "trash" ? "moved to trash" : action === "deletePermanent" ? "permanently deleted" : "restored"}.`,
        });
      }
      if (successCount < ids.length) {
        toast({
          title: "Partial Failure",
          description: `Failed to process ${ids.length - successCount} methods.`,
          variant: "default",
        });
      }

      fetchMethods(pagination.page);
      setSelectedMethods(new Set());
    } catch (error: any) {
      console.error(`Error during bulk ${action}:`, error);
      toast({
        title: "Error",
        description: error.message || `Failed to ${action} methods.`,
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const selectAllCheckedState = useMemo(() => {
    if (methods.length === 0) return false;
    if (selectedMethods.size === 0) return false;
    if (selectedMethods.size === methods.length) return true;
    return "indeterminate";
  }, [selectedMethods.size, methods.length]);

  const toggleMethodSelection = useCallback(
    (methodId: string, checked: boolean) => {
      setSelectedMethods((prev) => {
        const newSelection = new Set(prev);
        if (checked) newSelection.add(methodId);
        else newSelection.delete(methodId);
        return newSelection;
      });
    },
    [],
  );

  const toggleAllMethods = useCallback(
    (checked: boolean | "indeterminate") => {
      const isChecked = typeof checked === "boolean" ? checked : false;
      if (isChecked) setSelectedMethods(new Set(methods.map((m) => m.id)));
      else setSelectedMethods(new Set());
    },
    [methods],
  );

  const getSortIcon = useCallback(
    (field: SortField) => {
      if (sort.field !== field)
        return <ArrowUpDown className="ml-1 h-3.5 w-3.5 inline" />;
      return sort.order === "asc" ? (
        <ArrowUp className="ml-1 h-3.5 w-3.5 inline" />
      ) : (
        <ArrowDown className="ml-1 h-3.5 w-3.5 inline" />
      );
    },
    [sort],
  );

  const hasActiveFilters = searchQuery.trim().length > 0;
  const clearFilters = useCallback(() => {
    setSearchQuery("");
    const url = new URL(window.location.href);
    url.searchParams.delete("search");
    url.searchParams.set("page", "1");
    window.history.pushState({}, "", url.toString());
    fetchMethods(1, pagination.limit, "", sort, showTrashed);
  }, [pagination.limit, sort, showTrashed, fetchMethods]);

  const formatDate = (dateString?: string | number | Date) => {
    if (!dateString) return "N/A";
    try {
      const date = new Date(
        typeof dateString === "number" ? dateString * 1000 : dateString,
      );
      if (isNaN(date.getTime())) return "Invalid Date";
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch (e) {
      return "Invalid Date";
    }
  };

  return (
    <Card className="border-none shadow-none">
      <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2 border-b">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold tracking-tight">
              {showTrashed ? "Trashed Shipping Methods" : "Shipping Methods"}
            </CardTitle>
            <CardDescription className="mt-0 text-xs text-muted-foreground">
              {showTrashed
                ? "View and manage deleted shipping methods."
                : `Manage your store's shipping options. ${pagination.total} total methods.`}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={toggleTrash}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              {showTrashed ? (
                <>
                  <Truck className="h-3.5 w-3.5 mr-1" /> View Active
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> View Trash
                </>
              )}
            </Button>
            {!showTrashed && (
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={openFormForCreate}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Method
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="p-2 sm:p-3 space-y-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <div className="flex flex-1 items-center w-full sm:w-auto space-x-1.5">
              <form
                onSubmit={handleSearch}
                className="flex-1 sm:flex-initial sm:max-w-xs w-full"
              >
                <div className="relative">
                  <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search methods..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-7 h-7 w-full text-xs"
                  />
                </div>
              </form>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-xs text-muted-foreground"
                  onClick={clearFilters}
                >
                  <X className="h-3.5 w-3.5 mr-1" /> Clear
                </Button>
              )}
            </div>
            <div
              className={cn(
                "transition-opacity duration-200 flex items-center gap-2",
                selectedMethods.size > 0
                  ? "opacity-100"
                  : "opacity-0 pointer-events-none h-0 overflow-hidden sm:h-auto sm:opacity-100 sm:pointer-events-auto",
                selectedMethods.size === 0 && "sm:min-w-[90px]",
              )}
            >
              {selectedMethods.size > 0 ? (
                showTrashed ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setIsConfirmBulkRestoreOpen(true)}
                      disabled={isActionLoading || isLoading}
                    >
                      <Undo className="h-3.5 w-3.5 mr-1" /> Restore (
                      {selectedMethods.size})
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs text-destructive border-destructive hover:bg-destructive/10"
                      onClick={() => setIsConfirmBulkDeleteOpen(true)}
                      disabled={isActionLoading || isLoading}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete (
                      {selectedMethods.size})
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs text-destructive border-destructive hover:bg-destructive/10"
                    onClick={() => setIsConfirmBulkDeleteOpen(true)}
                    disabled={isActionLoading || isLoading}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" /> Trash (
                    {selectedMethods.size})
                  </Button>
                )
              ) : (
                <div className="h-7" />
              )}
            </div>
          </div>
        </div>

        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="w-10 pl-3 pr-1 py-2">
                  <Checkbox
                    checked={selectAllCheckedState}
                    onCheckedChange={toggleAllMethods}
                    aria-label="Select all methods"
                    disabled={methods.length === 0}
                    className="h-3.5 w-3.5"
                  />
                </TableHead>
                <TableHead className="py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("name")}
                  >
                    Name {getSortIcon("name")}
                  </Button>
                </TableHead>
                <TableHead className="py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("fee")}
                  >
                    Fee {getSortIcon("fee")}
                  </Button>
                </TableHead>
                <TableHead className="py-2 text-xs">Description</TableHead>
                <TableHead className="py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("isActive")}
                  >
                    Status {getSortIcon("isActive")}
                  </Button>
                </TableHead>
                <TableHead className="py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("sortOrder")}
                  >
                    Order {getSortIcon("sortOrder")}
                  </Button>
                </TableHead>
                <TableHead className="py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("updatedAt")}
                  >
                    Last Updated {getSortIcon("updatedAt")}
                  </Button>
                </TableHead>
                <TableHead className="w-[70px] text-right pr-3 py-2 text-xs">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="h-32 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && methods.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="h-32 text-center">
                    <div className="flex flex-col items-center justify-center gap-1.5">
                      <Truck className="h-8 w-8 text-muted-foreground/50" />
                      <p className="text-base font-medium text-muted-foreground">
                        {hasActiveFilters
                          ? "No methods match criteria."
                          : showTrashed
                            ? "Trash is empty."
                            : "No shipping methods yet."}
                      </p>
                      {!showTrashed && !hasActiveFilters && (
                        <Button
                          size="sm"
                          onClick={openFormForCreate}
                          className="mt-1 h-7 text-xs"
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          Add First Method
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!isLoading &&
                methods.map((method) => (
                  <TableRow
                    key={method.id}
                    className={cn(
                      "hover:bg-muted/50 transition-colors",
                      selectedMethods.has(method.id) && "bg-muted",
                    )}
                    data-state={
                      selectedMethods.has(method.id) ? "selected" : undefined
                    }
                  >
                    <TableCell className="pl-3 pr-1 py-2">
                      <Checkbox
                        checked={selectedMethods.has(method.id)}
                        onCheckedChange={(checked) =>
                          toggleMethodSelection(method.id, !!checked)
                        }
                        aria-label={`Select ${method.name}`}
                        className="h-3.5 w-3.5"
                      />
                    </TableCell>
                    <TableCell className="py-2 text-sm font-medium text-foreground">
                      {method.name}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      ৳{method.fee.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground truncate max-w-xs">
                      {method.description || "-"}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      <span
                        className={cn(
                          "px-2 py-0.5 rounded-full text-xs font-medium",
                          method.isActive
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700",
                        )}
                      >
                        {method.isActive ? "Active" : "Inactive"}
                      </span>
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">
                      {method.sortOrder}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">
                      {formatDate(method.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right pr-3 py-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-[170px]">
                          {showTrashed ? (
                            <>
                              <DropdownMenuItem
                                onClick={() => handleRestore(method.id)}
                              >
                                <Undo className="mr-2 h-3.5 w-3.5" />
                                Restore
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setMethodToDelete(method.id)}
                                className="text-destructive focus:text-destructive focus:bg-destructive/10"
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                Delete Permanently
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <>
                              <DropdownMenuItem
                                onClick={() => openFormForEdit(method)}
                              >
                                <Pencil className="mr-2 h-3.5 w-3.5" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setMethodToDelete(method.id)}
                                className="text-destructive focus:text-destructive focus:bg-destructive/10"
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                Move to Trash
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

        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between p-2 sm:p-3 border-t">
            <div className="text-xs text-muted-foreground hidden sm:block">
              {selectedMethods.size > 0
                ? `${selectedMethods.size} of ${pagination.total} row(s) selected.`
                : `Showing ${(pagination.page - 1) * pagination.limit + 1}-${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total}`}
            </div>
            <div className="flex items-center space-x-2 lg:space-x-3">
              <div className="flex items-center space-x-1.5">
                <p className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                  Rows
                </p>
                <Select
                  value={pagination.limit.toString()}
                  onValueChange={(value) => handleLimitChange(Number(value))}
                >
                  <SelectTrigger className="h-7 w-[60px] text-xs">
                    <SelectValue placeholder={pagination.limit} />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 20, 50, 100].map((s) => (
                      <SelectItem key={s} value={s.toString()}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-[90px] items-center justify-center text-xs font-medium text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages}
              </div>
              <div className="flex items-center space-x-0.5">
                <Button
                  variant="outline"
                  className="h-7 w-7 p-0 hidden lg:flex"
                  onClick={() => handlePageChange(1)}
                  disabled={pagination.page === 1 || isLoading}
                >
                  <ChevronsLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  className="h-7 w-7 p-0"
                  onClick={() => handlePageChange(pagination.page - 1)}
                  disabled={pagination.page === 1 || isLoading}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  className="h-7 w-7 p-0"
                  onClick={() => handlePageChange(pagination.page + 1)}
                  disabled={
                    pagination.page >= pagination.totalPages || isLoading
                  }
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  className="h-7 w-7 p-0 hidden lg:flex"
                  onClick={() => handlePageChange(pagination.totalPages)}
                  disabled={
                    pagination.page >= pagination.totalPages || isLoading
                  }
                >
                  <ChevronsRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingMethod ? "Edit" : "Create"} Shipping Method
            </DialogTitle>
            <DialogDescription>
              Fill in the details for the shipping method.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleFormSubmit} className="space-y-4">
            <div>
              <Label htmlFor="name" className="text-xs">
                Name
              </Label>
              <Input
                id="name"
                value={currentFormData.name || ""}
                onChange={(e) =>
                  setCurrentFormData((p) => ({ ...p, name: e.target.value }))
                }
                required
                className="mt-1 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="fee" className="text-xs">
                Fee (৳)
              </Label>
              <Input
                id="fee"
                type="number"
                step="0.01"
                value={currentFormData.fee ?? ""}
                onChange={(e) =>
                  setCurrentFormData((p) => ({
                    ...p,
                    fee: e.target.value ? parseFloat(e.target.value) : 0,
                  }))
                }
                required
                className="mt-1 text-sm"
                placeholder="0.00"
              />
            </div>
            <div>
              <Label htmlFor="description" className="text-xs">
                Description (Optional)
              </Label>
              <Textarea
                id="description"
                value={currentFormData.description || ""}
                onChange={(e) =>
                  setCurrentFormData((p) => ({
                    ...p,
                    description: e.target.value,
                  }))
                }
                className="mt-1 text-sm"
                rows={2}
              />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="isActive"
                checked={currentFormData.isActive}
                onCheckedChange={(checked) =>
                  setCurrentFormData((p) => ({ ...p, isActive: !!checked }))
                }
              />
              <Label htmlFor="isActive" className="text-xs font-normal">
                Active
              </Label>
            </div>
            <div>
              <Label htmlFor="sortOrder" className="text-xs">
                Sort Order
              </Label>
              <Input
                id="sortOrder"
                type="number"
                value={currentFormData.sortOrder ?? ""}
                onChange={(e) =>
                  setCurrentFormData((p) => ({
                    ...p,
                    sortOrder: e.target.value
                      ? parseInt(e.target.value, 10)
                      : 0,
                  }))
                }
                className="mt-1 text-sm"
                placeholder="0"
              />
            </div>
            <DialogFooter className="pt-2">
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs h-8"
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={isActionLoading}
                size="sm"
                className="text-xs h-8"
              >
                {isActionLoading && (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                )}{" "}
                {editingMethod ? "Save Changes" : "Create Method"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!methodToDelete && !showTrashed}
        onOpenChange={(open) => !open && setMethodToDelete(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <Trash2 className="h-4 w-4 text-amber-500" /> Move to Trash?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              Are you sure you want to move "
              {methods.find((m) => m.id === methodToDelete)?.name ||
                "this method"}
              " to trash? It can be restored later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleDelete()}
              className="h-8 text-xs"
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!methodToDelete && showTrashed}
        onOpenChange={(open) => !open && setMethodToDelete(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
              Permanently?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              This action cannot be undone. Are you sure you want to permanently
              delete "
              {methods.find((m) => m.id === methodToDelete)?.name ||
                "this method"}
              "?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handlePermanentDelete()}
              className="h-8 text-xs bg-destructive hover:bg-destructive/90"
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isConfirmBulkDeleteOpen}
        onOpenChange={setIsConfirmBulkDeleteOpen}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {showTrashed ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
                  Selected Permanently?
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move Selected to
                  Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to{" "}
              {showTrashed ? "permanently delete" : "move to trash"}{" "}
              {selectedMethods.size} method(s).
              {showTrashed && (
                <span className="font-medium text-destructive block mt-1 text-xs">
                  This action cannot be undone.
                </span>
              )}
              {!showTrashed && (
                <span className="block mt-1 text-xs">
                  They can be restored later.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                handleBulkAction(showTrashed ? "deletePermanent" : "trash")
              }
              className={cn(
                "h-8 text-xs",
                showTrashed && "bg-destructive hover:bg-destructive/90",
              )}
              disabled={isActionLoading || selectedMethods.size === 0}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              {showTrashed
                ? `Delete ${selectedMethods.size}`
                : `Move ${selectedMethods.size} to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isConfirmBulkRestoreOpen}
        onOpenChange={setIsConfirmBulkRestoreOpen}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <Undo className="h-4 w-4 text-green-500" /> Restore Selected
              Methods?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to restore {selectedMethods.size} method(s).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleBulkAction("restore")}
              className="h-8 text-xs"
              disabled={isActionLoading || selectedMethods.size === 0}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Restore {selectedMethods.size} Methods
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
