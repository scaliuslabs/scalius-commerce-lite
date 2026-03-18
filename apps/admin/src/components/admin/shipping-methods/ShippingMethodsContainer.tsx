import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  Search,
  Trash2,
  Plus,
  Loader2,
  AlertTriangle,
  Truck,
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  X,
} from "lucide-react";
import { useCurrency } from "@/hooks/use-currency";
import { useShippingMethods, type ShippingMethod } from "./hooks/useShippingMethods";
import { MethodsTable } from "./MethodsTable";
import { MethodFormDialog } from "./MethodFormDialog";
import { BulkActionsBar } from "./BulkActionsBar";

export function ShippingMethodsContainer() {
  const { symbol } = useCurrency();
  const {
    methods,
    pagination,
    searchQuery,
    setSearchQuery,
    sort,
    selectedMethods,
    isLoading,
    isActionLoading,
    showTrashed,
    hasActiveFilters,
    selectAllCheckedState,
    handleSearch,
    handleSort,
    handlePageChange,
    handleLimitChange,
    toggleTrash,
    clearFilters,
    handleFormSubmit,
    handleDelete,
    handlePermanentDelete,
    handleRestore,
    handleBulkAction,
    toggleMethodSelection,
    toggleAllMethods,
  } = useShippingMethods();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingMethod, setEditingMethod] = useState<ShippingMethod | null>(null);
  const [methodToDelete, setMethodToDelete] = useState<string | null>(null);
  const [isConfirmBulkDeleteOpen, setIsConfirmBulkDeleteOpen] = useState(false);
  const [isConfirmBulkRestoreOpen, setIsConfirmBulkRestoreOpen] = useState(false);

  const openFormForCreate = () => {
    setEditingMethod(null);
    setIsFormOpen(true);
  };

  const openFormForEdit = (method: ShippingMethod) => {
    setEditingMethod(method);
    setIsFormOpen(true);
  };

  const onFormSubmit = async (
    formData: Partial<ShippingMethod>,
    editingId: string | null,
  ) => {
    return handleFormSubmit(formData, editingId);
  };

  const onDeleteFromTable = (id: string) => {
    setMethodToDelete(id);
  };

  const confirmDelete = async () => {
    if (!methodToDelete) return;
    const id = methodToDelete;
    setMethodToDelete(null);
    if (showTrashed) {
      await handlePermanentDelete(id);
    } else {
      await handleDelete(id);
    }
  };

  const onBulkAction = async (action: "trash" | "deletePermanent" | "restore") => {
    setIsConfirmBulkDeleteOpen(false);
    setIsConfirmBulkRestoreOpen(false);
    await handleBulkAction(action);
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
              <Button size="sm" className="h-7 text-xs" onClick={openFormForCreate}>
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
            <BulkActionsBar
              selectedCount={selectedMethods.size}
              showTrashed={showTrashed}
              isActionLoading={isActionLoading}
              isLoading={isLoading}
              isConfirmBulkDeleteOpen={isConfirmBulkDeleteOpen}
              isConfirmBulkRestoreOpen={isConfirmBulkRestoreOpen}
              onOpenBulkDelete={() => setIsConfirmBulkDeleteOpen(true)}
              onOpenBulkRestore={() => setIsConfirmBulkRestoreOpen(true)}
              onCloseBulkDelete={() => setIsConfirmBulkDeleteOpen(false)}
              onCloseBulkRestore={() => setIsConfirmBulkRestoreOpen(false)}
              onBulkAction={onBulkAction}
            />
          </div>
        </div>

        <MethodsTable
          methods={methods}
          symbol={symbol}
          isLoading={isLoading}
          showTrashed={showTrashed}
          hasActiveFilters={hasActiveFilters}
          sort={sort}
          selectedMethods={selectedMethods}
          selectAllCheckedState={selectAllCheckedState}
          onSort={handleSort}
          onEdit={openFormForEdit}
          onDelete={onDeleteFromTable}
          onRestore={handleRestore}
          onToggleSelection={toggleMethodSelection}
          onToggleAll={toggleAllMethods}
          onCreateFirst={openFormForCreate}
        />

        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between p-2 sm:p-3 border-t">
            <div className="text-xs text-muted-foreground hidden sm:block">
              {selectedMethods.size > 0
                ? `${selectedMethods.size} of ${pagination.total} row(s) selected.`
                : `Showing ${(pagination.page - 1) * pagination.limit + 1}-${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total}`}
            </div>
            <div className="flex items-center space-x-2 lg:space-x-3">
              <div className="flex items-center space-x-1.5">
                <p className="text-xs font-medium text-muted-foreground whitespace-nowrap">Rows</p>
                <Select
                  value={pagination.limit.toString()}
                  onValueChange={(value) => handleLimitChange(Number(value))}
                >
                  <SelectTrigger className="h-7 w-[60px] text-xs">
                    <SelectValue placeholder={pagination.limit} />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 20, 50, 100].map((s) => (
                      <SelectItem key={s} value={s.toString()}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-[90px] items-center justify-center text-xs font-medium text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages}
              </div>
              <div className="flex items-center space-x-0.5">
                <Button variant="outline" className="h-7 w-7 p-0 hidden lg:flex" onClick={() => handlePageChange(1)} disabled={pagination.page === 1 || isLoading}>
                  <ChevronsLeft className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" className="h-7 w-7 p-0" onClick={() => handlePageChange(pagination.page - 1)} disabled={pagination.page === 1 || isLoading}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" className="h-7 w-7 p-0" onClick={() => handlePageChange(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages || isLoading}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" className="h-7 w-7 p-0 hidden lg:flex" onClick={() => handlePageChange(pagination.totalPages)} disabled={pagination.page >= pagination.totalPages || isLoading}>
                  <ChevronsRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>

      <MethodFormDialog
        isOpen={isFormOpen}
        onOpenChange={setIsFormOpen}
        editingMethod={editingMethod}
        isActionLoading={isActionLoading}
        symbol={symbol}
        onSubmit={onFormSubmit}
      />

      {/* Single delete confirmation */}
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
              {methods.find((m) => m.id === methodToDelete)?.name || "this method"}
              " to trash? It can be restored later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isActionLoading} className="h-8 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="h-8 text-xs" disabled={isActionLoading}>
              {isActionLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null} Move to Trash
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
              <AlertTriangle className="h-4 w-4 text-red-500" /> Delete Permanently?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              This action cannot be undone. Are you sure you want to permanently delete "
              {methods.find((m) => m.id === methodToDelete)?.name || "this method"}"?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isActionLoading} className="h-8 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="h-8 text-xs bg-destructive hover:bg-destructive/90" disabled={isActionLoading}>
              {isActionLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null} Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
