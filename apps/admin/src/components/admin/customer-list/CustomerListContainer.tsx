import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Badge } from "../../ui/badge";
import { useCurrency } from "@/hooks/useCurrency";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useCustomerListState } from "./hooks/useCustomerListState";
import { useCustomerListActions } from "./hooks/useCustomerListActions";
import { CustomerTable } from "./CustomerTable";
import { DeleteCustomerDialog } from "./DeleteCustomerDialog";
import type { Customer, CustomerListPagination, SortField } from "./hooks/useCustomerListState";

interface CustomerListProps {
  customers: Customer[];
  pagination: CustomerListPagination;
  initialSearchQuery?: string;
  initialSort?: {
    field: SortField;
    order: "asc" | "desc";
  };
  showTrashed?: boolean;
}

export function CustomerListContainer({
  customers: initialCustomers,
  pagination: initialPagination,
  initialSearchQuery = "",
  initialSort = { field: "updatedAt", order: "desc" },
  showTrashed = false,
}: CustomerListProps) {
  const { symbol } = useCurrency();

  const state = useCustomerListState(
    initialCustomers,
    initialPagination,
    initialSearchQuery,
    initialSort,
  );

  const actions = useCustomerListActions({
    showTrashed,
    initialPagination,
    searchQuery: state.searchQuery,
    localSearch: state.localSearch,
    sort: state.sort,
    currentPagination: state.currentPagination,
    selectedCustomers: state.selectedCustomers,
    searchTimeoutRef: state.searchTimeoutRef,
    prevSearchQueryRef: state.prevSearchQueryRef,
    setSearchQuery: state.setSearchQuery,
    setLocalSearch: state.setLocalSearch,
    setSort: state.setSort,
    setSelectedCustomers: state.setSelectedCustomers,
    setIsProcessing: state.setIsProcessing,
    setIsLoadingCustomers: state.setIsLoadingCustomers,
    setDisplayCustomers: state.setDisplayCustomers,
    setCurrentPagination: state.setCurrentPagination,
    setDialogState: state.setDialogState,
  });

  return (
    <>
      <Card>
        <CardHeader className="p-4 border-b">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-xl flex items-center gap-2">
                {showTrashed ? "Trash" : "Customers"}
                <Badge variant="secondary">{state.currentPagination.total}</Badge>
              </CardTitle>
              <CardDescription className="mt-1">
                {showTrashed
                  ? "Review and manage deleted customer records."
                  : "Browse, manage, and view your customer database."}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={actions.toggleTrashView}>
                {showTrashed ? (
                  <Users className="h-4 w-4" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                <span className="sr-only sm:not-sr-only sm:ml-2">
                  {showTrashed ? "Active" : "Trash"}
                </span>
              </Button>
              {!showTrashed ? (
                <Button size="sm" asChild>
                  <a href="/admin/customers/new">
                    <UserPlus className="h-4 w-4" />
                    <span className="sr-only sm:not-sr-only sm:ml-2">
                      Add New
                    </span>
                  </a>
                </Button>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <div className="p-4 flex items-center justify-between gap-4 bg-muted/20">
          <div className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50 shrink-0">
            Press <kbd className="px-1.5 py-0.5 bg-background border border-border rounded text-xs font-mono">/</kbd> to search
          </div>
          <form onSubmit={actions.handleSearch} className="flex-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                ref={state.searchInputRef}
                type="search"
                placeholder="Search by name, phone, or email..."
                value={state.localSearch}
                onChange={(e) => state.setLocalSearch(e.target.value)}
                className="pl-8 w-full max-w-md"
              />
            </div>
          </form>
          {state.selectedCustomers.size > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {state.selectedCustomers.size} selected
              </span>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive hover:bg-destructive/10"
                onClick={() => state.setDialogState({ action: "bulk-delete" })}
                disabled={state.isProcessing}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {showTrashed ? "Delete" : "Trash"} All
              </Button>
            </div>
          ) : null}
        </div>
        <CardContent className="p-0 relative">
          {state.isLoadingCustomers ? (
            <div className="absolute inset-0 bg-(--background)/80 backdrop-blur-sm z-10 flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                <p className="text-sm text-muted-foreground">Loading customers...</p>
              </div>
            </div>
          ) : null}
          <CustomerTable
            customers={state.displayCustomers}
            selectedCustomers={state.selectedCustomers}
            selectAllCheckedState={state.selectAllCheckedState}
            sort={state.sort}
            showTrashed={showTrashed}
            isProcessing={state.isProcessing}
            localSearch={state.localSearch}
            symbol={symbol}
            onToggleAll={state.toggleAllCustomers}
            onToggleSelection={state.toggleCustomerSelection}
            onSort={actions.handleSort}
            onDelete={actions.handleDelete}
            onRestore={actions.handleRestore}
            onSetDialog={state.setDialogState}
          />
        </CardContent>
        {state.currentPagination.totalPages > 1 ? (
          <CardHeader className="p-4 border-t flex-row items-center justify-between gap-4">
            <div className="text-sm text-muted-foreground">
              {state.selectedCustomers.size > 0
                ? `${state.selectedCustomers.size} of ${state.currentPagination.total} selected`
                : `Page ${state.currentPagination.page} of ${state.currentPagination.totalPages}`}
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    Rows: {state.currentPagination.limit}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {[10, 20, 50, 100].map((size) => (
                    <DropdownMenuItem
                      key={size}
                      onClick={() => actions.handleLimitChange(size)}
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
                  onClick={() => actions.handlePageChange(1)}
                  disabled={state.currentPagination.page === 1}
                >
                  <ChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => actions.handlePageChange(state.currentPagination.page - 1)}
                  disabled={state.currentPagination.page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => actions.handlePageChange(state.currentPagination.page + 1)}
                  disabled={state.currentPagination.page >= state.currentPagination.totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 hidden lg:flex"
                  onClick={() => actions.handlePageChange(state.currentPagination.totalPages)}
                  disabled={state.currentPagination.page >= state.currentPagination.totalPages}
                >
                  <ChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
        ) : null}
      </Card>
      <DeleteCustomerDialog
        dialogState={state.dialogState}
        showTrashed={showTrashed}
        isProcessing={state.isProcessing}
        selectedCount={state.selectedCustomers.size}
        onClose={() => state.setDialogState(undefined)}
        onConfirmSingle={actions.handleDelete}
        onConfirmPermanent={actions.handlePermanentDelete}
        onConfirmBulk={actions.handleBulkAction}
      />
    </>
  );
}
