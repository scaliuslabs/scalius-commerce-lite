// src/components/admin/widget-list/hooks/useBulkActions.ts
import { useState } from "react";
import { toast } from "sonner";
import { getServerFnError } from "@/lib/api-helpers";
import { bulkDeleteWidgets, bulkRestoreWidgets, bulkActivateWidgets, bulkDeactivateWidgets } from "@/lib/api.functions";
import type { BulkAction } from "../types";

export function useBulkActions(fetchWidgets: () => Promise<void>) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);

  const toggleSelection = (widgetId: string) => {
    setSelectedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(widgetId)) {
        newSet.delete(widgetId);
      } else {
        newSet.add(widgetId);
      }
      return newSet;
    });
  };

  const toggleSelectAll = (allWidgetIds: string[]) => {
    if (selectedIds.size === allWidgetIds.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allWidgetIds));
    }
  };

  const handleBulkAction = async (action: BulkAction | null) => {
    if (!action || selectedIds.size === 0) return;

    setIsActionLoading(true);

    try {
      const ids = Array.from(selectedIds);
      let successMessage = "";

      switch (action) {
        case "trash":
          await bulkDeleteWidgets({ data: { ids, permanent: false } });
          successMessage = `${selectedIds.size} widget(s) moved to trash.`;
          break;
        case "delete":
          await bulkDeleteWidgets({ data: { ids, permanent: true } });
          successMessage = `${selectedIds.size} widget(s) permanently deleted.`;
          break;
        case "restore":
          await bulkRestoreWidgets({ data: { ids } });
          successMessage = `${selectedIds.size} widget(s) restored.`;
          break;
        case "activate":
          await bulkActivateWidgets({ data: { ids } });
          successMessage = `${selectedIds.size} widget(s) activated.`;
          break;
        case "deactivate":
          await bulkDeactivateWidgets({ data: { ids } });
          successMessage = `${selectedIds.size} widget(s) deactivated.`;
          break;
      }

      toast.success("Success", { description: successMessage });

      setSelectedIds(new Set());
      setBulkAction(null);
      await fetchWidgets();
    } catch (error: unknown) {
      console.error(`Error performing bulk ${action}:`, error);
      toast.error("Error", { description: getServerFnError(error, `Failed to ${action} widgets.`) });
    } finally {
      setIsActionLoading(false);
    }
  };

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
