import React from "react";
import { ErrorBoundary } from "../../ErrorBoundary";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../ui/table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../../ui/card";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { Checkbox } from "../../../ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../../../ui/dropdown-menu";
import { Badge } from "../../../ui/badge";
import {
  Plus,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  Undo,
  Filter,
  Tag,
  X,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useCurrency } from "~/hooks/use-currency";
import { navigateTo } from "~/lib/client/navigate";
import { DiscountRow } from "./DiscountRow";
import { DiscountDeleteDialogs } from "./DiscountDeleteDialogs";
import { useDiscountListFilters } from "./hooks/useDiscountListFilters";
import type { DiscountItem, DiscountListPagination, SortField, SortOrder } from "./hooks/useDiscountListFilters";

interface DiscountListProps {
  discounts: DiscountItem[];
  pagination: DiscountListPagination;
  initialSearchQuery?: string;
  initialSort?: {
    field: SortField;
    order: SortOrder;
  };
  showTrashed?: boolean;
}

export function DiscountListContainer({
  discounts,
  pagination,
  initialSearchQuery = "",
  initialSort = { field: "updatedAt", order: "desc" },
  showTrashed = false,
}: DiscountListProps) {
  const { symbol } = useCurrency();

  const filters = useDiscountListFilters(
    discounts,
    pagination,
    initialSearchQuery,
    initialSort,
    showTrashed,
    symbol,
  );

  const getSortIcon = React.useCallback(
    (field: SortField) => {
      if (filters.sort.field !== field)
        return (
          <ArrowUpDown className="ml-2 h-4 w-4 text-muted-foreground/70" />
        );
      return filters.sort.order === "asc" ? (
        <ArrowUp className="ml-2 h-4 w-4 text-foreground" />
      ) : (
        <ArrowDown className="ml-2 h-4 w-4 text-foreground" />
      );
    },
    [filters.sort],
  );

  return (
    <ErrorBoundary fallback={<div className="p-4 text-center text-muted-foreground">Something went wrong loading discounts. <button onClick={() => window.location.reload()} className="underline">Reload</button></div>}>
    <Card className="overflow-hidden border border-border bg-card shadow-sm transition-all duration-300 hover:border-border hover:shadow-md">
      <CardHeader className="space-y-1.5 pb-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-xl font-semibold leading-none tracking-tight">
              {showTrashed ? "Deleted Discounts" : "Discounts"}
              {!showTrashed ? (
                <span className="ml-2 text-sm font-normal text-emerald-600 dark:text-emerald-400">
                  {pagination.total > 0 &&
                    `${pagination.total} total discounts`}
                </span>
              ) : null}
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
                void navigateTo(
                  showTrashed ? "/admin/discounts" : "/admin/discounts?trashed=true",
                );
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
            {!showTrashed ? (
              <Button
                size="sm"
                onClick={() => void navigateTo("/admin/discounts/new")}
                className="group h-9 px-3 text-xs font-medium shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:scale-110" />
                Add Discount
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="p-4 sm:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex flex-1 items-center w-full sm:w-auto space-x-2">
              <form
                onSubmit={filters.handleSearch}
                className="flex-1 sm:flex-initial sm:max-w-xs w-full"
              >
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search by code..."
                    value={filters.searchQuery}
                    onChange={(e) => filters.setSearchQuery(e.target.value)}
                    className="pl-8 h-9 w-full"
                  />
                </div>
              </form>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9">
                    <Filter className="h-4 w-4 mr-1.5" />
                    Type
                    {filters.activeType ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        (1)
                      </span>
                    ) : null}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup
                    value={filters.activeType || ""}
                    onValueChange={(value) => filters.handleTypeFilter(value || null)}
                  >
                    <DropdownMenuRadioItem value="">All Types</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="amount_off_products">Amount Off Products</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="amount_off_order">Amount Off Order</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="free_shipping">Free Shipping</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {filters.activeType ? (
                <div className="flex items-center gap-2">
                  <Badge
                    variant="secondary"
                    className="rounded-md px-2 py-0.5 text-xs"
                  >
                    Type: {filters.getTypeLabel(filters.activeType)}
                    <button
                      onClick={() => filters.handleTypeFilter(null)}
                      className="ml-1 rounded-full hover:bg-background p-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                      aria-label="Clear type filter"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                </div>
              ) : null}
            </div>

            <div
              className={cn(
                "transition-opacity duration-200 flex items-center gap-2",
                filters.selectedDiscounts.size > 0
                  ? "opacity-100"
                  : "opacity-0 pointer-events-none h-0 overflow-hidden sm:h-auto sm:opacity-100 sm:pointer-events-auto sm:w-auto",
                filters.selectedDiscounts.size === 0 && "sm:min-w-[100px]",
              )}
            >
              {filters.selectedDiscounts.size > 0 ? (
                <>
                  {showTrashed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9"
                      onClick={filters.handleBulkRestore}
                    >
                      <Undo className="h-4 w-4 mr-1.5" />
                      {`Restore (${filters.selectedDiscounts.size})`}
                    </Button>
                  ) : null}
                  <Button
                    variant={showTrashed ? "destructive" : "outline"}
                    size="sm"
                    className={cn(
                      "h-9",
                      showTrashed
                        ? ""
                        : "text-destructive border-destructive hover:bg-destructive/10",
                    )}
                    onClick={filters.handleBulkDelete}
                  >
                    <Trash2 className="h-4 w-4 mr-1.5" />
                    {showTrashed
                      ? `Delete (${filters.selectedDiscounts.size})`
                      : `Trash (${filters.selectedDiscounts.size})`}
                  </Button>
                </>
              ) : (
                <div className="h-9" />
              )}
            </div>
          </div>
        </div>

        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 pl-4 pr-2">
                  <Checkbox
                    checked={filters.selectAllCheckedState}
                    onCheckedChange={filters.handleSelectAll}
                    aria-label="Select all discounts on this page"
                  />
                </TableHead>
                <TableHead className="w-[200px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => filters.handleSort("code")}
                  >
                    Code {getSortIcon("code")}
                  </Button>
                </TableHead>
                <TableHead className="w-[140px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => filters.handleSort("type")}
                  >
                    Type {getSortIcon("type")}
                  </Button>
                </TableHead>
                <TableHead className="w-[120px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => filters.handleSort("value")}
                  >
                    Value {getSortIcon("value")}
                  </Button>
                </TableHead>
                <TableHead className="w-[110px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => filters.handleSort("startDate")}
                  >
                    Start {getSortIcon("startDate")}
                  </Button>
                </TableHead>
                <TableHead className="w-[110px]">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent"
                    onClick={() => filters.handleSort("endDate")}
                  >
                    End {getSortIcon("endDate")}
                  </Button>
                </TableHead>
                <TableHead className="w-[80px]">Usage</TableHead>
                <TableHead className="w-[100px]">Amount</TableHead>
                <TableHead className="w-[90px]">Status</TableHead>
                <TableHead className="w-[70px] text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filters.displayDiscounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="h-48 text-center">
                    <div className="flex flex-col items-center justify-center gap-3">
                      <Tag className="h-12 w-12 text-muted-foreground/50" />
                      <p className="text-lg font-medium text-muted-foreground">
                        {filters.searchQuery || filters.activeType
                          ? "No discounts match your criteria."
                          : showTrashed
                            ? "Trash is empty."
                            : "No discounts created yet."}
                      </p>
                      {!showTrashed && !filters.searchQuery && !filters.activeType ? (
                        <Button
                          size="sm"
                          onClick={() => void navigateTo("/admin/discounts/new")}
                          className="mt-2"
                        >
                          <Plus className="h-4 w-4 mr-1.5" />
                          Create First Discount
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filters.displayDiscounts.map((discount) => (
                  <DiscountRow
                    key={discount.id}
                    discount={discount}
                    isSelected={filters.selectedDiscounts.has(discount.id)}
                    onSelect={filters.handleSelectItem}
                    onEdit={filters.handleEdit}
                    onDelete={filters.handleDelete}
                    onRestore={filters.handleRestore}
                    onPermanentDelete={filters.handlePermanentDelete}
                    onToggleStatus={filters.handleToggleStatus}
                    showTrashed={showTrashed}
                    formatDate={filters.formatDate}
                    getTypeLabel={filters.getTypeLabel}
                    getDiscountValueDisplay={filters.getDiscountValueDisplay}
                    symbol={symbol}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {filters.currentPagination.totalPages > 1 ? (
          <div className="flex items-center justify-between p-4 sm:p-6 border-t">
            <div className="flex items-center gap-4">
              <div className="text-sm text-muted-foreground">
                Showing{" "}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {filters.currentPagination.total === 0
                    ? 0
                    : (filters.currentPagination.page - 1) * filters.currentPagination.limit + 1}
                </span>{" "}
                to{" "}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {Math.min(
                    filters.currentPagination.page * filters.currentPagination.limit,
                    filters.currentPagination.total,
                  )}
                </span>{" "}
                of{" "}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {filters.currentPagination.total}
                </span>{" "}
                discounts
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 px-2 text-xs">
                    {filters.currentPagination.limit} per page
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {[10, 20, 50, 100].map((pageSize) => (
                    <DropdownMenuItem
                      key={pageSize}
                      onClick={() => filters.handleLimitChange(pageSize)}
                      className={
                        filters.currentPagination.limit === pageSize
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
                onClick={() => filters.handlePageChange(filters.currentPagination.page - 1)}
                disabled={filters.currentPagination.page === 1}
                className="h-9 px-3 text-sm"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => filters.handlePageChange(filters.currentPagination.page + 1)}
                disabled={filters.currentPagination.page >= filters.currentPagination.totalPages}
                className="h-9 px-3 text-sm"
              >
                Next
              </Button>
            </nav>
          </div>
        ) : null}
      </CardContent>

      <DiscountDeleteDialogs
        deleteConfirmation={filters.deleteConfirmation}
        permanentDeleteConfirmation={filters.permanentDeleteConfirmation}
        bulkActionConfirmation={filters.bulkActionConfirmation}
        showTrashed={showTrashed}
        selectedCount={filters.selectedDiscounts.size}
        onDeleteCancel={() => filters.setDeleteConfirmation(null)}
        onDeleteConfirm={filters.handleDeleteConfirm}
        onPermanentDeleteCancel={() => filters.setPermanentDeleteConfirmation(null)}
        onPermanentDeleteConfirm={filters.handlePermanentDeleteConfirm}
        onBulkCancel={() => filters.setBulkActionConfirmation(null)}
        onBulkConfirm={filters.handleBulkActionConfirm}
      />
    </Card>
    </ErrorBoundary>
  );
}
