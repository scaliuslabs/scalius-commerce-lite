// src/components/admin/pages-list/PagesList.tsx
import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/card";

import { usePages, usePageActions, useBulkActions } from "./hooks";
import {
  PageStatistics,
  PageToolbar,
  PageTable,
  PagePagination,
  PageDeleteDialog,
} from "./components";
import { BulkActionDialog } from "@/components/admin/shared/BulkActionDialog";
import type { BulkActionConfig } from "@/components/admin/shared/BulkActionDialog";
import type { BulkAction } from "./types";

interface PagesListProps {
  showTrashed?: boolean;
}

export function PagesList({ showTrashed = false }: PagesListProps) {
  const {
    pages,
    pagination,
    isLoading,
    searchQuery,
    setSearchQuery,
    sortField,
    sortOrder,
    goToPage,
    changePageSize,
    handleSort,
    fetchPages,
  } = usePages(showTrashed);

  const { isActionLoading, handleDelete, handleRestore } =
    usePageActions(fetchPages);

  const [pageToDelete, setPageToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);

  const { isBulkActionLoading, handleBulkAction: performBulkAction } =
    useBulkActions(selectedIds, setSelectedIds, fetchPages);

  // Calculate statistics
  const publishedCount = pages.filter((p) => p.isPublished).length;
  const draftCount = pages.length - publishedCount;

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === pages.length && pages.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pages.map((p) => p.id)));
    }
  };

  const onDeleteConfirm = () => {
    if (!pageToDelete) return;
    handleDelete(pageToDelete.id, pageToDelete.title, showTrashed);
    setPageToDelete(null);
  };

  return (
    <div className="space-y-4">
      {/* Statistics Cards */}
      {!showTrashed && (
        <PageStatistics
          total={pagination.total}
          publishedCount={publishedCount}
          draftCount={draftCount}
        />
      )}

      <Card>
        <CardHeader>
          <PageToolbar
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            selectedIds={selectedIds}
            showTrashed={showTrashed}
            setBulkAction={setBulkAction}
            isActionLoading={isActionLoading || isBulkActionLoading}
          />
        </CardHeader>
        <PageTable
          pages={pages}
          isLoading={isLoading}
          selectedIds={selectedIds}
          isActionLoading={isActionLoading || isBulkActionLoading}
          showTrashed={showTrashed}
          sortField={sortField}
          sortOrder={sortOrder}
          searchQuery={searchQuery}
          onSort={handleSort}
          onDelete={(id, title) => setPageToDelete({ id, title })}
          onRestore={handleRestore}
          onPermanentDelete={(id, title) => setPageToDelete({ id, title })}
          onToggleSelection={toggleSelection}
          onToggleSelectAll={toggleSelectAll}
        />
        {!isLoading && pages.length > 0 && (
          <PagePagination
            pagination={pagination}
            goToPage={goToPage}
            changePageSize={changePageSize}
          />
        )}
      </Card>

      <PageDeleteDialog
        pageToDelete={pageToDelete}
        setPageToDelete={setPageToDelete}
        showTrashed={showTrashed}
        isActionLoading={isActionLoading}
        onDeleteConfirm={onDeleteConfirm}
      />

      <BulkActionDialog
        open={bulkAction !== null}
        onOpenChange={(open) => { if (!open) setBulkAction(null); }}
        currentAction={bulkAction}
        selectedCount={selectedIds.size}
        actionConfigs={{
          trash: {
            title: "Move pages to trash?",
            description: `${selectedIds.size} page(s) will be moved to trash and can be restored later.`,
            confirmLabel: "Move to Trash",
            variant: "destructive",
          },
          delete: {
            title: "Permanently delete pages?",
            description: `This action cannot be undone. ${selectedIds.size} page(s) will be permanently deleted.`,
            confirmLabel: "Delete Permanently",
            variant: "destructive",
          },
          restore: {
            title: "Restore pages?",
            description: `${selectedIds.size} page(s) will be restored from trash.`,
            confirmLabel: "Restore",
          },
          publish: {
            title: "Publish pages?",
            description: `${selectedIds.size} page(s) will be published and visible to the public.`,
            confirmLabel: "Publish",
          },
          unpublish: {
            title: "Unpublish pages?",
            description: `${selectedIds.size} page(s) will be unpublished and hidden from the public.`,
            confirmLabel: "Unpublish",
          },
        } satisfies Record<string, BulkActionConfig>}
        onConfirm={() => {
          if (bulkAction) {
            performBulkAction(bulkAction);
            setBulkAction(null);
          }
        }}
        isLoading={isBulkActionLoading}
      />
    </div>
  );
}
