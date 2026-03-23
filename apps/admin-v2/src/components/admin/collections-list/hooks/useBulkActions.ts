// src/components/admin/collections-list/hooks/useBulkActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import {
  bulkDeleteCollections,
  bulkRestoreCollections,
  bulkActivateCollections,
  bulkDeactivateCollections,
} from "~/lib/api.functions";
import type { BulkAction } from "../types";

export function useBulkActions(onRefresh: () => void) {
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);

  const bulkMutation = useMutation({
    mutationFn: async ({ action, ids }: { action: NonNullable<BulkAction>; ids: string[] }) => {
      switch (action) {
        case "trash":
          return bulkDeleteCollections({ data: { collectionIds: ids } });
        case "delete":
          return bulkDeleteCollections({ data: { collectionIds: ids, permanent: true } });
        case "restore":
          return bulkRestoreCollections({ data: { ids } });
        case "activate":
          return bulkActivateCollections({ data: { ids } });
        case "deactivate":
          return bulkDeactivateCollections({ data: { ids } });
      }
    },
    onSuccess: (_data, { ids }) => {
      toast.success(`${ids.length} collections processed successfully.`);
      setSelectedIds(new Set());
      onRefresh();
    },
    onError: (error, { action }) => {
      toast.error(getServerFnError(error, `Bulk ${action} failed.`));
    },
    onSettled: () => {
      setBulkAction(null);
      queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
  });

  const handleBulkAction = useCallback(
    (action: BulkAction) => {
      if (!action || selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      bulkMutation.mutate({ action, ids });
    },
    [selectedIds, bulkMutation],
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
    isActionLoading: bulkMutation.isPending,
    setBulkAction,
    handleBulkAction,
    toggleSelection,
    toggleSelectAll,
  };
}
