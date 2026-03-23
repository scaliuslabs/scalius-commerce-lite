// src/components/admin/attributes-manager/hooks/useBulkActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import { bulkDeleteAttributes, bulkRestoreAttributes } from "~/lib/api.functions";
import type { BulkAction } from "../types";

export function useBulkActions(onRefresh: () => void) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);

  const handleBulkAction = useCallback(
    async (action: BulkAction) => {
      if (!action || selectedIds.size === 0) return;
      setIsActionLoading(true);

      const ids = Array.from(selectedIds);

      try {
        if (action === "restore") {
          await bulkRestoreAttributes({ data: { ids } });
        } else {
          await bulkDeleteAttributes({
            data: { ids, permanent: action === "delete" },
          });
        }
        toast.success(`${selectedIds.size} attributes processed successfully.`);
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

  const toggleSelectAll = useCallback((attributeIds: string[]) => {
    setSelectedIds((prev) => {
      if (prev.size === attributeIds.length && attributeIds.length > 0) {
        return new Set();
      } else {
        return new Set(attributeIds);
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
