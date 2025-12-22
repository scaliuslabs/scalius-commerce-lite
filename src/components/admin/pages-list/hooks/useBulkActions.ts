// src/components/admin/pages-list/hooks/useBulkActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import type { BulkAction } from "../types";

export function useBulkActions(
  selectedIds: Set<string>,
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>,
  onRefresh: () => void,
) {
  const [isBulkActionLoading, setIsBulkActionLoading] = useState(false);

  const handleBulkAction = useCallback(
    async (action: BulkAction) => {
      if (!action || selectedIds.size === 0) return;
      setIsBulkActionLoading(true);

      const endpointMap = {
        trash: "/api/pages/bulk-delete",
        delete: "/api/pages/bulk-delete",
        restore: "/api/pages/bulk-restore",
        publish: "/api/pages/bulk-publish",
        unpublish: "/api/pages/bulk-unpublish",
      };

      let body: any = { pageIds: Array.from(selectedIds) };

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

        toast.success(`${selectedIds.size} pages processed successfully.`);
        setSelectedIds(new Set());
        onRefresh();
      } catch (error: any) {
        toast.error(error.message);
      } finally {
        setIsBulkActionLoading(false);
      }
    },
    [selectedIds, setSelectedIds, onRefresh],
  );

  return { isBulkActionLoading, handleBulkAction };
}
