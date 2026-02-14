// src/components/admin/discount/DiscountList.tsx
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../ui/card";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Checkbox } from "../../ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "../../ui/dropdown-menu";
import {
  Plus,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  Undo,
  Pencil,
  Filter,
  Tag,
  Percent,
  Truck,
  MoreHorizontal,
  X,
  Check,
  Copy,
  Clock,
} from "lucide-react";
import { Badge } from "../../ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// --- Type Definitions (Unchanged) ---
type SortField =
  | "code"
  | "type"
  | "value"
  | "startDate"
  | "endDate"
  | "createdAt"
  | "updatedAt";
type SortOrder = "asc" | "desc";

interface DiscountItem {
  id: string;
  code: string;
  type: string;
  valueType: string;
  discountValue: number;
  minPurchaseAmount: number | null;
  minQuantity: number | null;
  maxUsesPerOrder: number | null;
  maxUses: number | null;
  limitOnePerCustomer: boolean;
  combineWithProductDiscounts: boolean;
  combineWithOrderDiscounts: boolean;
  combineWithShippingDiscounts: boolean;
  customerSegment: string | null;
  startDate: string | null; // ISO date string
  endDate: string | null; // ISO date string
  isActive: boolean;
  createdAt: string | null; // ISO date string
  updatedAt: string | null; // ISO date string
  deletedAt: string | null; // ISO date string
  relatedProducts: { buy: string[]; get: string[] };
  relatedCollections: { buy: string[]; get: string[] };
  // Add new statistics fields
  usageCount?: number;
  totalDiscountAmount?: number;
}

interface DiscountListProps {
  discounts: DiscountItem[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  initialSearchQuery?: string;
  initialSort?: {
    field: SortField;
    order: SortOrder;
  };
  showTrashed?: boolean;
}
// --- End Type Definitions ---

// Build a concise discount summary for tooltip display
function buildDiscountSummary(
  discount: DiscountItem,
  getTypeLabel: (type: string) => string,
  getDiscountValueDisplay: (discount: DiscountItem) => string,
): string[] {
  const lines: string[] = [];
  lines.push(`Type: ${getTypeLabel(discount.type)}`);
  lines.push(`Value: ${getDiscountValueDisplay(discount)}`);
  if (discount.minPurchaseAmount) {
    lines.push(`Min purchase: ৳${discount.minPurchaseAmount.toLocaleString()}`);
  }
  if (discount.minQuantity) {
    lines.push(`Min quantity: ${discount.minQuantity}`);
  }
  if (discount.maxUsesPerOrder) {
    lines.push(`Max per order: ${discount.maxUsesPerOrder}`);
  }
  if (discount.limitOnePerCustomer) {
    lines.push("Limit: 1 per customer");
  }
  if (discount.customerSegment) {
    lines.push(`Segment: ${discount.customerSegment}`);
  }
  const combines: string[] = [];
  if (discount.combineWithProductDiscounts) combines.push("product");
  if (discount.combineWithOrderDiscounts) combines.push("order");
  if (discount.combineWithShippingDiscounts) combines.push("shipping");
  if (combines.length > 0) {
    lines.push(`Combines with: ${combines.join(", ")}`);
  }
  return lines;
}

// Enhanced Row Component with Action Dropdown
const DiscountRow = React.memo(
  ({
    discount,
    isSelected,
    onSelect,
    onEdit,
    onDelete,
    onRestore,
    onPermanentDelete,
    onToggleStatus,
    showTrashed,
    formatDate,
    getTypeLabel,
    getDiscountValueDisplay,
  }: {
    discount: DiscountItem;
    isSelected: boolean;
    onSelect: (id: string, checked: boolean) => void;
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
    onRestore: (id: string) => void;
    onPermanentDelete: (id: string) => void;
    onToggleStatus: (id: string, currentStatus: boolean) => void;
    showTrashed: boolean;
    formatDate: (date: string | null) => string;
    getTypeLabel: (type: string) => string;
    getDiscountValueDisplay: (discount: DiscountItem) => string;
  }) => {
    const summaryLines = buildDiscountSummary(discount, getTypeLabel, getDiscountValueDisplay);

    return (
      <TableRow
        className={cn(
          "hover:bg-muted/50 transition-colors", // Subtle hover effect
          isSelected && "bg-muted", // Indicate selection
        )}
        data-state={isSelected && "selected"}
      >
        <TableCell className="pl-4 pr-2">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) => onSelect(discount.id, !!checked)}
            aria-label={`Select ${discount.code}`}
          />
        </TableCell>
        <TableCell className="font-medium">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2 cursor-default">
                  <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate font-semibold text-foreground">
                    {discount.code}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                <div className="space-y-1 text-xs">
                  <p className="font-semibold text-sm mb-1.5">{discount.code}</p>
                  {summaryLines.map((line, i) => (
                    <p key={i} className="text-muted-foreground">{line}</p>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
        <TableCell>
          <Badge
            variant="outline"
            className={cn(
              "text-xs font-medium",
              discount.type === "amount_off_products" &&
                "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-700",
              discount.type === "amount_off_order" &&
                "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-700",
              discount.type === "free_shipping" &&
                "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-700",
            )}
          >
            {discount.type === "amount_off_products" && (
              <Tag className="h-3 w-3 mr-1" />
            )}
            {discount.type === "amount_off_order" && (
              <Percent className="h-3 w-3 mr-1" />
            )}
            {discount.type === "free_shipping" && (
              <Truck className="h-3 w-3 mr-1" />
            )}
            {getTypeLabel(discount.type)}
          </Badge>
        </TableCell>
        <TableCell>
          <Badge variant="secondary">{getDiscountValueDisplay(discount)}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">
          {formatDate(discount.startDate)}
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">
          {discount.endDate ? formatDate(discount.endDate) : "No end date"}
        </TableCell>
        {/* Usage stats column - show progress when limit exists */}
        <TableCell>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="space-y-1">
                  <div className="flex items-center gap-1">
                    <span className="font-medium">
                      {discount.usageCount !== undefined
                        ? discount.usageCount
                        : "-"}
                    </span>
                    {discount.maxUses ? (
                      <span className="text-muted-foreground text-xs">
                        / {discount.maxUses}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        uses
                      </span>
                    )}
                  </div>
                  {discount.maxUses && discount.usageCount !== undefined && (
                    <div className="w-full bg-gray-200 rounded-full h-1 dark:bg-gray-700">
                      <div
                        className={cn(
                          "h-1 rounded-full transition-all",
                          (discount.usageCount / discount.maxUses) >= 1
                            ? "bg-red-500"
                            : (discount.usageCount / discount.maxUses) >= 0.8
                              ? "bg-amber-500"
                              : "bg-green-500",
                        )}
                        style={{
                          width: `${Math.min(100, (discount.usageCount / discount.maxUses) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {discount.maxUses
                    ? `${discount.usageCount || 0} of ${discount.maxUses} uses consumed`
                    : "Times this discount code has been used"}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
        {/* Total discount amount column */}
        <TableCell>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1">
                  <span className="font-medium">
                    {discount.totalDiscountAmount !== undefined
                      ? `৳${discount.totalDiscountAmount.toLocaleString()}`
                      : "-"}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Total discount amount given</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
        {/* Status cell - smart status with Scheduled/Expired */}
        <TableCell>
          {!showTrashed && (() => {
            const now = new Date();
            const startDate = discount.startDate ? new Date(discount.startDate) : null;
            const endDate = discount.endDate ? new Date(discount.endDate) : null;
            const isExpired = endDate && endDate < now;
            const isScheduled = startDate && startDate > now;

            if (isExpired) {
              return (
                <Badge
                  variant="outline"
                  className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-900/30 dark:text-gray-400"
                >
                  Expired
                </Badge>
              );
            }

            if (isScheduled && discount.isActive) {
              return (
                <Badge
                  variant="outline"
                  className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400"
                >
                  <Clock className="h-3 w-3 mr-1" />
                  Scheduled
                </Badge>
              );
            }

            return (
              <Button
                variant="ghost"
                size="sm"
                className="p-0 h-auto hover:bg-transparent"
                onClick={() => onToggleStatus(discount.id, discount.isActive)}
              >
                <Badge
                  variant={discount.isActive ? "default" : "outline"}
                  className={cn(
                    discount.isActive
                      ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-700"
                      : "text-muted-foreground",
                    "text-xs font-medium px-2 py-0.5 rounded-full",
                  )}
                >
                  {discount.isActive ? "Active" : "Inactive"}
                </Badge>
              </Button>
            );
          })()}
          {showTrashed && (
            <Badge
              variant="outline"
              className="text-muted-foreground text-xs font-medium px-2 py-0.5 rounded-full"
            >
              Deleted
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-right pr-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[160px]">
              {showTrashed ? (
                <>
                  <DropdownMenuItem onClick={() => onRestore(discount.id)}>
                    <Undo className="mr-2 h-4 w-4" />
                    <span>Restore</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onPermanentDelete(discount.id)}
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    <span>Delete Permanently</span>
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => onEdit(discount.id)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    <span>Edit</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      // Navigate to create page with type pre-selected, code will need to be changed
                      const params = new URLSearchParams({
                        duplicate: discount.id,
                      });
                      window.location.href = `/admin/discounts/${discount.id}/edit?duplicate=true`;
                    }}
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    <span>Duplicate</span>
                  </DropdownMenuItem>
                  {/* Status toggle in dropdown too */}
                  <DropdownMenuItem
                    onClick={() =>
                      onToggleStatus(discount.id, discount.isActive)
                    }
                  >
                    {discount.isActive ? (
                      <>
                        <X className="mr-2 h-4 w-4" />
                        <span>Deactivate</span>
                      </>
                    ) : (
                      <>
                        <Check className="mr-2 h-4 w-4" />
                        <span>Activate</span>
                      </>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onDelete(discount.id)}
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    <span>Delete</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>
    );
  },
);

DiscountRow.displayName = "DiscountRow";

export function DiscountList({
  discounts,
  pagination,
  initialSearchQuery = "",
  initialSort = { field: "updatedAt", order: "desc" },
  showTrashed = false,
}: DiscountListProps) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [sort, setSort] = useState(initialSort);
  const [selectedDiscounts, setSelectedDiscounts] = useState<Set<string>>(
    new Set(),
  );
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(
    null,
  );
  const [permanentDeleteConfirmation, setPermanentDeleteConfirmation] =
    useState<string | null>(null);
  const [bulkDeleteConfirmation, setBulkDeleteConfirmation] = useState(false);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [displayDiscounts, setDisplayDiscounts] = useState<DiscountItem[]>(
    discounts || [],
  );
  const [currentPagination, setCurrentPagination] = useState(pagination);

  useEffect(() => {
    setDisplayDiscounts(discounts || []);
  }, [discounts]);

  useEffect(() => {
    setCurrentPagination(pagination);
  }, [pagination]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const typeFromUrl = url.searchParams.get("type");
    setActiveType(typeFromUrl);
    setSort({
      field: (url.searchParams.get("sort") || initialSort.field) as SortField,
      order: (url.searchParams.get("order") || initialSort.order) as SortOrder,
    });
    setSearchQuery(url.searchParams.get("search") || initialSearchQuery);
  }, [initialSort.field, initialSort.order, initialSearchQuery]); // Rerun if initial props change

  // --- Callbacks for actions (Unchanged logic, only adjusted state updates) ---
  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const url = new URL(window.location.href);
      if (searchQuery.trim()) {
        url.searchParams.set("search", searchQuery.trim());
      } else {
        url.searchParams.delete("search");
      }
      url.searchParams.delete("page");
      window.location.href = url.toString();
    },
    [searchQuery],
  );

  const handleSort = useCallback((field: SortField) => {
    const url = new URL(window.location.href);
    const currentOrder = url.searchParams.get("order");
    const currentSort = url.searchParams.get("sort");
    const newOrder =
      currentSort === field && currentOrder === "asc" ? "desc" : "asc";
    url.searchParams.set("sort", field);
    url.searchParams.set("order", newOrder);
    window.location.href = url.toString();
  }, []);

  const handlePageChange = useCallback((newPage: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("page", newPage.toString());
    window.location.href = url.toString();
  }, []);

  const handleLimitChange = useCallback((newLimit: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("limit", newLimit.toString());
    url.searchParams.delete("page"); // Reset to page 1 on limit change
    window.location.href = url.toString();
  }, []);

  const handleEdit = useCallback((id: string) => {
    window.location.href = `/admin/discounts/${id}/edit`;
  }, []);

  const handleDelete = useCallback((id: string) => {
    setDeleteConfirmation(id);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirmation) return;
    const idToDelete = deleteConfirmation; // Store id before clearing state
    setDeleteConfirmation(null); // Close dialog immediately for better UX

    try {
      const response = await fetch(`/api/discounts/${idToDelete}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete discount");
      }

      toast({
        title: "Discount moved to trash",
        description: "The discount has been moved to trash successfully.",
      });

      // Optimistic UI update
      setDisplayDiscounts((prev) => prev.filter((d) => d.id !== idToDelete));
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1), // Prevent negative total
        totalPages: Math.ceil((prev.total - 1) / prev.limit),
      }));
      // Optionally: re-fetch data or trigger parent component update
      // window.location.reload(); // Less ideal, but ensures consistency if needed
    } catch (error) {
      console.error("Error deleting discount:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to delete discount",
        variant: "destructive",
      });
      // Optionally revert optimistic update or show specific error message
    }
  }, [deleteConfirmation, toast]);

  const handlePermanentDelete = useCallback((id: string) => {
    setPermanentDeleteConfirmation(id);
  }, []);

  const handlePermanentDeleteConfirm = useCallback(async () => {
    if (!permanentDeleteConfirmation) return;
    const idToDelete = permanentDeleteConfirmation;
    setPermanentDeleteConfirmation(null);

    try {
      const response = await fetch(`/api/discounts/${idToDelete}/permanent`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to permanently delete discount");
      }

      toast({
        title: "Discount deleted permanently",
        description: "The discount has been permanently deleted.",
      });

      setDisplayDiscounts((prev) => prev.filter((d) => d.id !== idToDelete));
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        totalPages: Math.ceil((prev.total - 1) / prev.limit),
      }));
    } catch (error) {
      console.error("Error permanently deleting discount:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to delete discount permanently",
        variant: "destructive",
      });
    }
  }, [permanentDeleteConfirmation, toast]);

  const handleRestore = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/discounts/${id}/restore`, {
          method: "POST",
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to restore discount");
        }

        toast({
          title: "Discount restored",
          description: "The discount has been restored successfully.",
        });

        setDisplayDiscounts((prev) => prev.filter((d) => d.id !== id));
        setCurrentPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - 1),
          totalPages: Math.ceil((prev.total - 1) / prev.limit),
        }));
      } catch (error) {
        console.error("Error restoring discount:", error);
        toast({
          title: "Error",
          description:
            error instanceof Error
              ? error.message
              : "Failed to restore discount",
          variant: "destructive",
        });
      }
    },
    [toast],
  );

  const handleBulkDelete = useCallback(() => {
    if (selectedDiscounts.size > 0) {
      setBulkDeleteConfirmation(true);
    }
  }, [selectedDiscounts]);

  const handleBulkDeleteConfirm = useCallback(async () => {
    if (selectedDiscounts.size === 0) return;
    const idsToDelete = Array.from(selectedDiscounts);
    setBulkDeleteConfirmation(false); // Close dialog

    try {
      const response = await fetch(`/api/discounts/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          discountIds: idsToDelete,
          permanent: showTrashed,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete discounts");
      }

      toast({
        title: showTrashed
          ? "Discounts deleted permanently"
          : "Discounts moved to trash",
        description: `${idsToDelete.length} discounts have been ${showTrashed ? "permanently deleted" : "moved to trash"}.`,
      });

      setDisplayDiscounts((prev) =>
        prev.filter((d) => !idsToDelete.includes(d.id)),
      );
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - idsToDelete.length),
        totalPages: Math.ceil((prev.total - idsToDelete.length) / prev.limit),
      }));
      setSelectedDiscounts(new Set()); // Clear selection
    } catch (error) {
      console.error("Error bulk deleting discounts:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to delete discounts",
        variant: "destructive",
      });
    }
  }, [selectedDiscounts, showTrashed, toast]);

  const handleTypeFilter = useCallback((type: string | null) => {
    const url = new URL(window.location.href);
    if (type) {
      url.searchParams.set("type", type);
    } else {
      url.searchParams.delete("type");
    }
    url.searchParams.delete("page"); // Reset page on filter change
    window.location.href = url.toString();
  }, []);

  const getSortIcon = useCallback(
    (field: SortField) => {
      if (sort.field !== field)
        return (
          <ArrowUpDown className="ml-2 h-4 w-4 text-muted-foreground/70" />
        );
      return sort.order === "asc" ? (
        <ArrowUp className="ml-2 h-4 w-4 text-foreground" />
      ) : (
        <ArrowDown className="ml-2 h-4 w-4 text-foreground" />
      );
    },
    [sort],
  );

  const formatDate = useCallback((dateString: string | null) => {
    if (!dateString) return "N/A";
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return "Invalid Date";
      // Use a slightly more compact date format
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        // hour: 'numeric',
        // minute: '2-digit',
        // hour12: true,
      });
    } catch (error) {
      console.error("Error formatting date:", error, dateString);
      return "Invalid Date";
    }
  }, []);

  const getTypeLabel = useCallback((type: string) => {
    // Keep consistent with provided types
    switch (type) {
      case "amount_off_products":
        return "Amount Off Products";
      case "amount_off_order":
        return "Amount Off Order";
      case "free_shipping":
        return "Free Shipping";
      default:
        return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()); // Format fallback
    }
  }, []);

  const getDiscountValueDisplay = useCallback((discount: DiscountItem) => {
    switch (discount.valueType) {
      case "percentage":
        return `${discount.discountValue}% off`;
      case "fixed_amount":
        return `৳${discount.discountValue.toFixed(2)} off`; // Use currency symbol
      case "free":
        return "Free";
      default:
        return discount.discountValue.toString();
    }
  }, []);

  const handleSelectItem = useCallback((id: string, checked: boolean) => {
    setSelectedDiscounts((prev) => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(id);
      } else {
        newSet.delete(id);
      }
      return newSet;
    });
  }, []);

  const handleSelectAll = useCallback(
    (checked: boolean | "indeterminate") => {
      // Handle indeterminate state if needed, otherwise treat as boolean
      const isChecked = typeof checked === "boolean" ? checked : false;
      if (isChecked) {
        const allIds = new Set(displayDiscounts.map((discount) => discount.id));
        setSelectedDiscounts(allIds);
      } else {
        setSelectedDiscounts(new Set());
      }
    },
    [displayDiscounts],
  );

  // Determine checkbox state for "select all"
  const selectAllCheckedState = useMemo(() => {
    if (selectedDiscounts.size === 0) return false;
    if (selectedDiscounts.size === displayDiscounts.length) return true;
    return "indeterminate"; // Partially selected
  }, [selectedDiscounts.size, displayDiscounts.length]);

  // Remove the hardcoded slice - rely on pagination
  const visibleDiscounts = useMemo(() => displayDiscounts, [displayDiscounts]);

  // Add new callback for toggling status
  const handleToggleStatus = useCallback(
    async (id: string, currentStatus: boolean) => {
      try {
        const response = await fetch(`/api/discounts/${id}/toggle-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: !currentStatus }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to update discount status");
        }

        toast({
          title: `Discount ${!currentStatus ? "activated" : "deactivated"}`,
          description: `The discount code has been ${!currentStatus ? "activated" : "deactivated"} successfully.`,
        });

        // Update the UI optimistically
        setDisplayDiscounts((prev) =>
          prev.map((discount) =>
            discount.id === id
              ? { ...discount, isActive: !currentStatus }
              : discount,
          ),
        );
      } catch (error) {
        console.error("Error toggling discount status:", error);
        toast({
          title: "Error",
          description:
            error instanceof Error
              ? error.message
              : "Failed to update discount status",
          variant: "destructive",
        });
      }
    },
    [toast],
  );

  return (
    <Card className="overflow-hidden border border-gray-100/50 bg-white/50 shadow-sm backdrop-blur-xl transition-all duration-300 hover:border-gray-200/50 hover:shadow-md dark:bg-gray-900/50 dark:border-gray-800/50 dark:hover:border-gray-700/50">
      <CardHeader className="space-y-1.5 pb-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-xl font-semibold leading-none tracking-tight">
              {showTrashed ? "Deleted Discounts" : "Discounts"}
              {!showTrashed && (
                <span className="ml-2 text-sm font-normal text-emerald-600 dark:text-emerald-400">
                  {pagination.total > 0 &&
                    `${pagination.total} total discounts`}
                </span>
              )}
            </CardTitle>
            <CardDescription className="text-sm text-gray-500 dark:text-gray-400">
              {showTrashed
                ? "View and manage deleted discounts"
                : "Manage your discounts and promotional codes"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                window.location.href = showTrashed
                  ? "/admin/discounts"
                  : "/admin/discounts?trashed=true";
              }}
              className="group h-9 border-gray-200 bg-white/80 px-3 text-xs font-medium shadow-sm backdrop-blur-lg transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:bg-white hover:shadow-md active:translate-y-0 dark:bg-gray-800/80 dark:border-gray-700 dark:hover:bg-gray-800 dark:hover:border-gray-600"
            >
              {showTrashed ? (
                <>
                  <Tag className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-110" />
                  View Active
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
                onClick={() => (window.location.href = "/admin/discounts/new")}
                className="group h-9 px-3 text-xs font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-110" />
                Add Discount
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="p-4 sm:p-6 space-y-4">
          {/* Toolbar: Search, Filter, Bulk Actions */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex flex-1 items-center w-full sm:w-auto space-x-2">
              <form
                onSubmit={handleSearch}
                className="flex-1 sm:flex-initial sm:max-w-xs w-full"
              >
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search by code..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-8 h-9 w-full"
                  />
                </div>
              </form>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9">
                    <Filter className="h-4 w-4 mr-1.5" />
                    Type
                    {activeType && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        (1)
                      </span>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup
                    value={activeType || ""}
                    onValueChange={(value) => handleTypeFilter(value || null)}
                  >
                    <DropdownMenuRadioItem value="">
                      All Types
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="amount_off_products">
                      Amount Off Products
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="amount_off_order">
                      Amount Off Order
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="free_shipping">
                      Free Shipping
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Active Filters Display */}
              {activeType && (
                <div className="flex items-center gap-2">
                  <Badge
                    variant="secondary"
                    className="rounded-md px-2 py-0.5 text-xs"
                  >
                    Type: {getTypeLabel(activeType)}
                    <button
                      onClick={() => handleTypeFilter(null)}
                      className="ml-1 rounded-full hover:bg-background p-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                      aria-label="Clear type filter"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                </div>
              )}
            </div>

            {/* Bulk Actions Area */}
            <div
              className={cn(
                "transition-opacity duration-200 flex items-center gap-2",
                selectedDiscounts.size > 0
                  ? "opacity-100"
                  : "opacity-0 pointer-events-none h-0 overflow-hidden sm:h-auto sm:opacity-100 sm:pointer-events-auto sm:w-auto", // Conditional visibility/space
                selectedDiscounts.size === 0 && "sm:min-w-[100px]", // Reserve space even when hidden on larger screens
              )}
            >
              {
                selectedDiscounts.size > 0 ? (
                  <Button
                    variant={showTrashed ? "destructive" : "outline"}
                    size="sm"
                    className={cn(
                      "h-9",
                      showTrashed
                        ? "" // Destructive variant handles its own text/icon colors (e.g., text-destructive-foreground)
                        : "text-destructive border-destructive hover:bg-destructive/10", // Specific styles for the "Trash" outline button
                    )}
                    onClick={handleBulkDelete} // Changed to trigger confirmation first
                  >
                    <Trash2 className="h-4 w-4 mr-1.5" />{" "}
                    {/* Icon color will inherit from button text color */}
                    {showTrashed
                      ? `Delete (${selectedDiscounts.size})`
                      : `Trash (${selectedDiscounts.size})`}
                  </Button>
                ) : (
                  <div className="h-9" />
                ) /* Placeholder to prevent layout shift */
              }
            </div>
          </div>
        </div>
        {/* Table */}
        <div className="border-t">
          {" "}
          {/* Use border-t for separation */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 pl-4 pr-2">
                  <Checkbox
                    checked={selectAllCheckedState}
                    onCheckedChange={handleSelectAll}
                    aria-label="Select all discounts on this page"
                  />
                </TableHead>
                <TableHead className="w-[200px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => handleSort("code")}
                  >
                    Code {getSortIcon("code")}
                  </Button>
                </TableHead>
                <TableHead className="w-[140px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => handleSort("type")}
                  >
                    Type {getSortIcon("type")}
                  </Button>
                </TableHead>
                <TableHead className="w-[120px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => handleSort("value")}
                  >
                    Value {getSortIcon("value")}
                  </Button>
                </TableHead>
                <TableHead className="w-[110px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => handleSort("startDate")}
                  >
                    Start {getSortIcon("startDate")}
                  </Button>
                </TableHead>
                <TableHead className="w-[110px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => handleSort("endDate")}
                  >
                    End {getSortIcon("endDate")}
                  </Button>
                </TableHead>
                {/* New columns for usage stats */}
                <TableHead className="w-[80px]">Usage</TableHead>
                <TableHead className="w-[100px]">Amount</TableHead>
                <TableHead className="w-[90px]">Status</TableHead>
                <TableHead className="w-[70px] text-right pr-4">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleDiscounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="h-48 text-center">
                    {/* Updated colspan to match column count */}
                    <div className="flex flex-col items-center justify-center gap-3">
                      <Tag className="h-12 w-12 text-muted-foreground/50" />
                      <p className="text-lg font-medium text-muted-foreground">
                        {searchQuery || activeType
                          ? "No discounts match your criteria."
                          : showTrashed
                            ? "Trash is empty."
                            : "No discounts created yet."}
                      </p>
                      {!showTrashed && !searchQuery && !activeType && (
                        <Button
                          size="sm"
                          onClick={() =>
                            (window.location.href = "/admin/discounts/new")
                          }
                          className="mt-2"
                        >
                          <Plus className="h-4 w-4 mr-1.5" />
                          Create First Discount
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                visibleDiscounts.map((discount) => (
                  <DiscountRow
                    key={discount.id}
                    discount={discount}
                    isSelected={selectedDiscounts.has(discount.id)}
                    onSelect={handleSelectItem}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onRestore={handleRestore}
                    onPermanentDelete={handlePermanentDelete}
                    onToggleStatus={handleToggleStatus}
                    showTrashed={showTrashed}
                    formatDate={formatDate}
                    getTypeLabel={getTypeLabel}
                    getDiscountValueDisplay={getDiscountValueDisplay}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {/* Pagination */}
        {currentPagination.totalPages > 1 && (
          <div className="flex items-center justify-between p-4 sm:p-6 border-t">
            <div className="flex items-center gap-4">
              <div className="text-sm text-muted-foreground">
                Showing{" "}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {currentPagination.total === 0
                    ? 0
                    : (currentPagination.page - 1) * currentPagination.limit +
                      1}
                </span>{" "}
                to{" "}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {Math.min(
                    currentPagination.page * currentPagination.limit,
                    currentPagination.total,
                  )}
                </span>{" "}
                of{" "}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {currentPagination.total}
                </span>{" "}
                discounts
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 text-xs"
                  >
                    {currentPagination.limit} per page
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {[10, 20, 50, 100].map((pageSize) => (
                    <DropdownMenuItem
                      key={pageSize}
                      onClick={() => handleLimitChange(pageSize)}
                      className={
                        currentPagination.limit === pageSize
                          ? "bg-gray-100 font-medium dark:bg-gray-700"
                          : ""
                      }
                    >
                      {pageSize} per page
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <nav aria-label="Pagination" className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(currentPagination.page - 1)}
                disabled={currentPagination.page === 1}
                className="h-9 px-3 text-sm"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(currentPagination.page + 1)}
                disabled={
                  currentPagination.page >= currentPagination.totalPages
                }
                className="h-9 px-3 text-sm"
              >
                Next
              </Button>
            </nav>
          </div>
        )}
      </CardContent>
      {/* --- Confirmation Dialogs (Unchanged Structure) --- */}
      <AlertDialog
        open={!!deleteConfirmation}
        onOpenChange={(open) => !open && setDeleteConfirmation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move to Trash?</AlertDialogTitle>
            <AlertDialogDescription>
              This discount will be moved to the trash. You can restore it later
              from the trash view.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!permanentDeleteConfirmation && showTrashed}
        onOpenChange={(open) => !open && setPermanentDeleteConfirmation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The discount will be permanently
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handlePermanentDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={bulkDeleteConfirmation}
        onOpenChange={setBulkDeleteConfirmation}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will {showTrashed ? "permanently delete" : "move to trash"}{" "}
              the selected {selectedDiscounts.size} discount(s).
              {showTrashed && " This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {showTrashed
                ? `Delete ${selectedDiscounts.size} items`
                : `Move ${selectedDiscounts.size} items to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
