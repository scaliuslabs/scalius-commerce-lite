// src/components/admin/collections-list/hooks/useBulkActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import {
  bulkDeleteCollections,
  bulkRestoreCollections,
  bulkActivateCollections,
  bulkDeactivateCollections,
} from "~/lib/api.functions";
import type { BulkAction } from "../types";

export function useBulkActions(onRefresh: () => void) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);

  const handleBulkAction = useCallback(
    async (action: BulkAction) => {
      if (!action || selectedIds.size === 0) return;
      setIsActionLoading(true);

      const selected = Array.from(selectedIds);

      try {
        switch (action) {
          case "trash":
            await bulkDeleteCollections({ data: { collectionIds: selected } });
            break;
          case "delete":
            await bulkDeleteCollections({ data: { collectionIds: selected, permanent: true } });
            break;
          case "restore":
            await bulkRestoreCollections({ data: { ids: selected } });
            break;
          case "activate":
            await bulkActivateCollections({ data: { ids: selected } });
            break;
          case "deactivate":
            await bulkDeactivateCollections({ data: { ids: selected } });
            break;
        }

        toast.success(
          `${selectedIds.size} collections processed successfully.`,
        );
        setSelectedIds(new Set());
        onRefresh();
      } catch (error: unknown) {
        toast.error(getServerFnError(error, `Bulk ${action} failed.`));
      } finally {
        setIsActionLoading(false);
        setBulkAction(null);
      }
    },
    [selectedIds, onRefresh],
  );

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  }, []);

  const toggleSelectAll = useCallback((collectionIds: string[]) => {
    setSelectedIds((prev) => {
      if (prev.size === collectionIds.length && collectionIds.length > 0) {
        return new Set();
      } else {
        return new Set(collectionIds);
      }
    });
  }, []);

  return {
    selectedIds,
    bulkAction,
    isActionLoading,
    setBulkAction,
    handleBulkAction,
    toggleSelection,
    toggleSelectAll,
  };
}
