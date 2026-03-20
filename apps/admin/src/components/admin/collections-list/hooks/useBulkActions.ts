// src/components/admin/collections-list/hooks/useBulkActions.ts
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
        trash: "/api/v1/admin/collections/bulk-delete",
        delete: "/api/v1/admin/collections/bulk-delete",
        restore: "/api/v1/admin/collections/bulk-restore",
        activate: "/api/v1/admin/collections/bulk-activate",
        deactivate: "/api/v1/admin/collections/bulk-deactivate",
      };

      const selected = Array.from(selectedIds);
      const body: Record<string, unknown> =
        action === "trash" || action === "delete"
          ? { collectionIds: selected }
          : { ids: selected };

      if (action === "delete") body.permanent = true;

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

        toast.success(
          `${selectedIds.size} collections processed successfully.`,
        );
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
