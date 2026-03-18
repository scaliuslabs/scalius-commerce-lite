// src/components/admin/collections-list/CollectionsList.tsx
import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardDescription,
} from "@/components/ui/card";
import { useDebounce } from "@/hooks/use-debounce";
import { useCollections } from "./hooks/useCollections";
import { useCollectionActions } from "./hooks/useCollectionActions";
import { useBulkActions } from "./hooks/useBulkActions";
import {
  CollectionStatistics,
  CollectionToolbar,
  CollectionTable,
  CollectionPagination,
  CollectionDeleteDialog,
} from "./components";
import { BulkActionDialog } from "@/components/admin/shared/BulkActionDialog";
import type { BulkActionConfig } from "@/components/admin/shared/BulkActionDialog";
import type {
  CollectionsManagerProps,
  SortField,
  SortOrder,
  DeleteDialogState,
} from "./types";
import { navigateTo } from "@/lib/client/navigate";

export function CollectionsList({
  showTrashed = false,
}: CollectionsManagerProps) {
  // Search and sort state
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("sortOrder");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [isDragging, setIsDragging] = useState(false);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // Dialog states
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(
    null,
  );

  // Custom hooks
  const {
    collections,
    setCollections,
    pagination,
    isLoading,
    fetchCollections,
    goToPage,
    changePageSize,
  } = useCollections(showTrashed, debouncedSearchQuery, sortField, sortOrder);

  const {
    savingStates,
    isActionLoading,
    handleUpdate,
    handleDelete,
    handleRestore,
    handleReorder,
  } = useCollectionActions(fetchCollections, setCollections);

  const {
    selectedIds,
    bulkAction,
    isActionLoading: isBulkActionLoading,
    setBulkAction,
    handleBulkAction,
    toggleSelection,
    toggleSelectAll,
  } = useBulkActions(fetchCollections);

  // Calculate statistics
  const activeCount = collections.filter((c) => c.isActive).length;
  const inactiveCount = collections.length - activeCount;

  // Sort handler
  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  // Drag and drop handlers
  const handleDragEnd = async (result: { source: { index: number }; destination?: { index: number } | null }) => {
    setIsDragging(false);
    if (!result.destination) return;

    const items = Array.from(collections);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    // Update local state immediately for smooth UI
    setCollections(items);

    // Prepare the new order data
    const updatedOrder = items.map((item, index) => ({
      id: item.id,
      sortOrder: index,
    }));

    try {
      await handleReorder(updatedOrder);
    } catch (error: unknown) {
      // Revert to original order on error
      fetchCollections();
    }
  };

  const handleDeleteCollection = () => {
    if (!deleteDialog) return;
    handleDelete(deleteDialog.id, deleteDialog.name, showTrashed);
    setDeleteDialog(null);
  };

  const handleCreateClick = () => {
    void navigateTo("/admin/collections/new");
  };

  return (
    <div className="space-y-4">
      {/* Statistics Cards */}
      {!showTrashed && (
        <CollectionStatistics
          total={pagination.total}
          activeCount={activeCount}
          inactiveCount={inactiveCount}
        />
      )}

      <Card>
        <CardHeader>
          <CollectionToolbar
            searchQuery={searchQuery}
            selectedCount={selectedIds.size}
            showTrashed={showTrashed}
            isActionLoading={isActionLoading || isBulkActionLoading}
            onSearchChange={setSearchQuery}
            onBulkTrash={() => setBulkAction("trash")}
            onBulkDelete={() => setBulkAction("delete")}
            onBulkRestore={() => setBulkAction("restore")}
            onBulkActivate={() => setBulkAction("activate")}
            onBulkDeactivate={() => setBulkAction("deactivate")}
          />
          {!showTrashed && isDragging && (
            <CardDescription className="mt-2">
              Drop to reposition the collection
            </CardDescription>
          )}
          {!showTrashed && !isDragging && !searchQuery && (
            <CardDescription className="mt-2">
              Drag collections to change their display order on your store
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <CollectionTable
            collections={collections}
            selectedIds={selectedIds}
            savingStates={savingStates}
            isActionLoading={isActionLoading}
            isLoading={isLoading}
            showTrashed={showTrashed}
            searchQuery={searchQuery}
            sortField={sortField}
            sortOrder={sortOrder}
            isDragging={isDragging}
            onSort={handleSort}
            onUpdate={handleUpdate}
            onDelete={(id, name) => setDeleteDialog({ id, name })}
            onRestore={handleRestore}
            onToggleSelection={toggleSelection}
            onToggleSelectAll={() =>
              toggleSelectAll(collections.map((c) => c.id))
            }
            onCreateClick={handleCreateClick}
            onDragEnd={handleDragEnd}
            onDragStart={() => setIsDragging(true)}
          />

          {/* Pagination Controls */}
          {!isLoading && collections.length > 0 && (
            <CollectionPagination
              pagination={pagination}
              onPageChange={goToPage}
              onPageSizeChange={changePageSize}
            />
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <CollectionDeleteDialog
        open={!!deleteDialog}
        deleteDialog={deleteDialog}
        showTrashed={showTrashed}
        isActionLoading={isActionLoading}
        onOpenChange={() => setDeleteDialog(null)}
        onConfirm={handleDeleteCollection}
      />

      {/* Bulk Action Confirmation Dialog */}
      <BulkActionDialog
        open={!!bulkAction}
        onOpenChange={() => setBulkAction(null)}
        currentAction={bulkAction}
        selectedCount={selectedIds.size}
        actionConfigs={{
          activate: {
            title: "Activate Collections?",
            description: `Are you sure you want to activate ${selectedIds.size} selected collections?`,
            confirmLabel: "Activate",
          },
          deactivate: {
            title: "Deactivate Collections?",
            description: `Are you sure you want to deactivate ${selectedIds.size} selected collections?`,
            confirmLabel: "Deactivate",
          },
          trash: {
            title: "Move Collections to Trash?",
            description: `Are you sure you want to move ${selectedIds.size} selected collections to trash? You can restore them later.`,
            confirmLabel: "Move to Trash",
          },
          restore: {
            title: "Restore Collections?",
            description: `Are you sure you want to restore ${selectedIds.size} selected collections?`,
            confirmLabel: "Restore",
          },
          delete: {
            title: "Delete Collections Permanently?",
            description: `Are you sure you want to permanently delete ${selectedIds.size} selected collections? This action cannot be undone.`,
            confirmLabel: "Delete Permanently",
            variant: "destructive",
          },
        } satisfies Record<string, BulkActionConfig>}
        onConfirm={() => handleBulkAction(bulkAction)}
        isLoading={isBulkActionLoading}
      />
    </div>
  );
}
