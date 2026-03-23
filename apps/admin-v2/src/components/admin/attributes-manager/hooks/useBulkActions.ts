// src/components/admin/attributes-manager/hooks/useBulkActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import { bulkDeleteAttributes, bulkRestoreAttributes } from "~/lib/api.functions";
import type { BulkAction } from "../types";

export function useBulkActions(onRefresh: () => void) {
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);

  const bulkMutation = useMutation({
    mutationFn: async ({ action, ids }: { action: NonNullable<BulkAction>; ids: string[] }) => {
      if (action === "restore") {
        return bulkRestoreAttributes({ data: { ids } });
      }
      return bulkDeleteAttributes({
        data: { ids, permanent: action === "delete" },
      });
    },
    onSuccess: (_data, { ids }) => {
      toast.success(`${ids.length} attributes processed successfully.`);
      setSelectedIds(new Set());
      onRefresh();
    },
    onError: (error, { action }) => {
      toast.error(getServerFnError(error, `Bulk ${action} failed.`));
    },
    onSettled: () => {
      setBulkAction(null);
      queryClient.invalidateQueries({ queryKey: ["attributes"] });
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
    isActionLoading: bulkMutation.isPending,
    setBulkAction,
    handleBulkAction,
    toggleSelection,
    toggleSelectAll,
  };
}
