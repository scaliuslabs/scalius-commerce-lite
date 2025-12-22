// src/components/admin/collections-list/hooks/useBulkActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import type { BulkAction } from "../types";

export function useBulkActions(onRefresh: () => void) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);

  const handleBulkAction = useCallback(
    async (action: BulkAction) => {
      if (!action || selectedIds.size === 0) return;
      setIsActionLoading(true);

      const endpointMap = {
        trash: "/api/collections/bulk-delete",
        delete: "/api/collections/bulk-delete",
        restore: "/api/collections/bulk-restore",
        activate: "/api/collections/bulk-activate",
        deactivate: "/api/collections/bulk-deactivate",
      };

      let body: any = { collectionIds: Array.from(selectedIds) };

      if (action === "delete") {
        body.permanent = true;
      }

      try {
        const response = await fetch(endpointMap[action], {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Bulk ${action} failed.`);
        }

        toast.success(
          `${selectedIds.size} collections processed successfully.`,
        );
        setSelectedIds(new Set());
        onRefresh();
      } catch (error: any) {
        toast.error(error.message);
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
