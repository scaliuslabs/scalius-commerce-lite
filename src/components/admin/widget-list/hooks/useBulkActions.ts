// src/components/admin/widget-list/hooks/useBulkActions.ts
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import type { BulkAction } from "../types";

export function useBulkActions(fetchWidgets: () => Promise<void>) {
  const { toast } = useToast();
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
      let endpoint = "";
      let successMessage = "";

      switch (action) {
        case "trash":
          endpoint = "/api/widgets/bulk-delete";
          successMessage = `${selectedIds.size} widget(s) moved to trash.`;
          break;
        case "delete":
          endpoint = "/api/widgets/bulk-delete";
          successMessage = `${selectedIds.size} widget(s) permanently deleted.`;
          break;
        case "restore":
          endpoint = "/api/widgets/bulk-restore";
          successMessage = `${selectedIds.size} widget(s) restored.`;
          break;
        case "activate":
          endpoint = "/api/widgets/bulk-activate";
          successMessage = `${selectedIds.size} widget(s) activated.`;
          break;
        case "deactivate":
          endpoint = "/api/widgets/bulk-deactivate";
          successMessage = `${selectedIds.size} widget(s) deactivated.`;
          break;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: Array.from(selectedIds),
          permanent: action === "delete",
        }),
      });

      if (!response.ok) throw new Error(`Failed to ${action} widgets`);

      toast({
        title: "Success",
        description: successMessage,
      });

      setSelectedIds(new Set());
      setBulkAction(null);
      await fetchWidgets();
    } catch (error) {
      console.error(`Error performing bulk ${action}:`, error);
      toast({
        title: "Error",
        description: `Failed to ${action} widgets.`,
        variant: "destructive",
      });
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

