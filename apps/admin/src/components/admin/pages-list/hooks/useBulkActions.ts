// src/components/admin/pages-list/hooks/useBulkActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { extractApiError } from "@/lib/api-helpers";
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
        trash: "/api/v1/admin/pages/bulk-delete",
        delete: "/api/v1/admin/pages/bulk-delete",
        restore: "/api/v1/admin/pages/bulk-restore",
        publish: "/api/v1/admin/pages/bulk-publish",
        unpublish: "/api/v1/admin/pages/bulk-unpublish",
      };

      const selected = Array.from(selectedIds);
      const body: Record<string, unknown> =
        action === "trash" || action === "delete"
          ? { pageIds: selected }
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

        toast.success(`${selectedIds.size} pages processed successfully.`);
        setSelectedIds(new Set());
        onRefresh();
      } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setIsBulkActionLoading(false);
      }
    },
    [selectedIds, setSelectedIds, onRefresh],
  );

  return { isBulkActionLoading, handleBulkAction };
}
