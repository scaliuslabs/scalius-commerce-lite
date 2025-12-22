// src/components/admin/attributes-manager/AttributesManager.tsx
import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useDebounce } from "@/hooks/use-debounce";
import { useAttributes } from "./hooks/useAttributes";
import { useAttributeActions } from "./hooks/useAttributeActions";
import { useBulkActions } from "./hooks/useBulkActions";
import {
  AttributeStatistics,
  AttributeToolbar,
  AttributeTable,
  AttributePagination,
  AttributeCreateDialog,
  AttributeDeleteDialog,
  BulkActionDialog,
  AttributeValuesViewer,
  AttributeValueEditor,
} from "./components";
import type {
  AttributesManagerProps,
  SortField,
  SortOrder,
  DeleteDialogState,
  NewAttribute,
} from "./types";

export function AttributesManager({
  showTrashed = false,
}: AttributesManagerProps) {
  // Search and sort state
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // Dialog states
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(
    null,
  );
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newAttribute, setNewAttribute] = useState<NewAttribute>({
    name: "",
    slug: "",
    filterable: true,
    options: [],
  });
  const [viewValuesFor, setViewValuesFor] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [editValuesFor, setEditValuesFor] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Custom hooks
  const {
    attributes,
    setAttributes,
    pagination,
    isLoading,
    fetchAttributes,
    goToPage,
    changePageSize,
  } = useAttributes(showTrashed, debouncedSearchQuery, sortField, sortOrder);

  const {
    savingStates,
    isActionLoading,
    isCreating,
    handleUpdate,
    handleCreate,
    handleDelete,
    handleRestore,
  } = useAttributeActions(fetchAttributes, setAttributes);

  const {
    selectedIds,
    bulkAction,
    isActionLoading: isBulkActionLoading,
    setBulkAction,
    handleBulkAction,
    toggleSelection,
    toggleSelectAll,
  } = useBulkActions(fetchAttributes);

  // Calculate statistics
  const totalValueCount = attributes.reduce(
    (sum, attr) => sum + (attr.valueCount || 0),
    0,
  );
  const filterableCount = attributes.filter((attr) => attr.filterable).length;

  // Sort handler
  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  // New attribute handlers
  const handleNewAttributeNameChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const name = e.target.value;
    const slug = name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    setNewAttribute((prev) => ({ ...prev, name, slug }));
  };

  const handleCreateAttribute = () => {
    handleCreate(newAttribute, () => {
      setNewAttribute({ name: "", slug: "", filterable: true, options: [] });
      setShowCreateDialog(false);
    });
  };

  const handleDeleteAttribute = () => {
    if (!deleteDialog) return;
    handleDelete(deleteDialog.id, deleteDialog.name, showTrashed);
    setDeleteDialog(null);
  };

  return (
    <div className="space-y-4">
      {/* Statistics Cards */}
      {!showTrashed && (
        <AttributeStatistics
          total={pagination.total}
          filterableCount={filterableCount}
          totalValueCount={totalValueCount}
        />
      )}

      <Card>
        <CardHeader>
          <AttributeToolbar
            searchQuery={searchQuery}
            selectedCount={selectedIds.size}
            showTrashed={showTrashed}
            isActionLoading={isActionLoading || isBulkActionLoading}
            onSearchChange={setSearchQuery}
            onBulkTrash={() => setBulkAction("trash")}
            onBulkDelete={() => setBulkAction("delete")}
            onBulkRestore={() => setBulkAction("restore")}
            onCreateClick={() => setShowCreateDialog(true)}
          />
        </CardHeader>
        <CardContent className="p-0">
          <AttributeTable
            attributes={attributes}
            selectedIds={selectedIds}
            savingStates={savingStates}
            isActionLoading={isActionLoading}
            isLoading={isLoading}
            showTrashed={showTrashed}
            searchQuery={searchQuery}
            sortField={sortField}
            sortOrder={sortOrder}
            onSort={handleSort}
            onUpdate={handleUpdate}
            onDelete={(id, name) => setDeleteDialog({ id, name })}
            onRestore={handleRestore}
            onViewValues={(id, name) => setViewValuesFor({ id, name })}
            onEditValues={(id, name) => setEditValuesFor({ id, name })}
            onToggleSelection={toggleSelection}
            onToggleSelectAll={() =>
              toggleSelectAll(attributes.map((a) => a.id))
            }
            onCreateClick={() => setShowCreateDialog(true)}
          />

          {/* Pagination Controls */}
          {!isLoading && attributes.length > 0 && (
            <AttributePagination
              pagination={pagination}
              onPageChange={goToPage}
              onPageSizeChange={changePageSize}
            />
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AttributeDeleteDialog
        open={!!deleteDialog}
        deleteDialog={deleteDialog}
        showTrashed={showTrashed}
        isActionLoading={isActionLoading}
        onOpenChange={() => setDeleteDialog(null)}
        onConfirm={handleDeleteAttribute}
      />

      {/* Bulk Action Confirmation Dialog */}
      <BulkActionDialog
        open={!!bulkAction}
        bulkAction={bulkAction}
        selectedCount={selectedIds.size}
        isActionLoading={isBulkActionLoading}
        onOpenChange={() => setBulkAction(null)}
        onConfirm={() => handleBulkAction(bulkAction)}
      />

      {/* Create Attribute Dialog */}
      <AttributeCreateDialog
        open={showCreateDialog}
        newAttribute={newAttribute}
        isCreating={isCreating}
        onOpenChange={setShowCreateDialog}
        onNameChange={handleNewAttributeNameChange}
        onSlugChange={(slug) => setNewAttribute((prev) => ({ ...prev, slug }))}
        onFilterableChange={(checked) =>
          setNewAttribute((prev) => ({ ...prev, filterable: checked }))
        }
        onOptionsChange={(options) =>
          setNewAttribute((prev) => ({ ...prev, options }))
        }
        onCreate={handleCreateAttribute}
      />

      {/* Attribute Values Viewer */}
      <AttributeValuesViewer
        attributeId={viewValuesFor?.id || null}
        attributeName={viewValuesFor?.name || null}
        onClose={() => setViewValuesFor(null)}
      />

      {/* Attribute Value Editor */}
      <AttributeValueEditor
        attributeId={editValuesFor?.id || null}
        attributeName={editValuesFor?.name || null}
        onClose={() => setEditValuesFor(null)}
      />
    </div>
  );
}
