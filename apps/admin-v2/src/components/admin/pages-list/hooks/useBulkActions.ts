// src/components/admin/pages-list/hooks/useBulkActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { getServerFnError } from "@/lib/api-helpers";
import { bulkDeletePages, bulkRestorePages, bulkPublishPages, bulkUnpublishPages } from "@/lib/api.functions";
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

      const selected = Array.from(selectedIds);

      try {
        switch (action) {
          case "trash":
            await bulkDeletePages({ data: { pageIds: selected } });
            break;
          case "delete":
            await bulkDeletePages({ data: { pageIds: selected, permanent: true } });
            break;
          case "restore":
            await bulkRestorePages({ data: { ids: selected } });
            break;
          case "publish":
            await bulkPublishPages({ data: { ids: selected } });
            break;
          case "unpublish":
            await bulkUnpublishPages({ data: { ids: selected } });
            break;
        }

        toast.success(`${selectedIds.size} pages processed successfully.`);
        setSelectedIds(new Set());
        onRefresh();
      } catch (error: unknown) {
        toast.error(getServerFnError(error, `Bulk ${action} failed.`));
      } finally {
        setIsBulkActionLoading(false);
      }
    },
    [selectedIds, setSelectedIds, onRefresh],
  );

  return { isBulkActionLoading, handleBulkAction };
}
