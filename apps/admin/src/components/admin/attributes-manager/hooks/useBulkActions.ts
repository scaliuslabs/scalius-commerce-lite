// src/components/admin/attributes-manager/hooks/useBulkActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { extractApiError } from "@/lib/api-helpers";
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
        trash: "/api/v1/admin/attributes/bulk-delete",
        delete: "/api/v1/admin/attributes/bulk-delete",
        restore: "/api/v1/admin/attributes/bulk-restore",
      };

      const body =
        action === "restore"
          ? { ids: Array.from(selectedIds) }
          : {
            ids: Array.from(selectedIds),
            permanent: action === "delete",
          };

      try {
        const response = await fetch(endpointMap[action], {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(extractApiError(errorData, `Bulk ${action} failed.`));
        }
        toast.success(`${selectedIds.size} attributes processed successfully.`);
        setSelectedIds(new Set());
        onRefresh();
      } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : String(error));
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
