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
  BulkActionDialog,
} from "./components";
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
        bulkAction={bulkAction}
        setBulkAction={setBulkAction}
        selectedIds={selectedIds}
        isBulkActionLoading={isBulkActionLoading}
        showTrashed={showTrashed}
        onPerformBulkAction={performBulkAction}
      />
    </div>
  );
}
