// src/components/admin/widget-list/hooks/useWidgetActions.ts
import { useState } from "react";
import { toast } from "sonner";
import type { WidgetItem } from "../types";
import { getServerFnError } from "@/lib/api-helpers";
import { updateWidget, deleteWidget, restoreWidget } from "@/lib/api.functions";

export function useWidgetActions(
  _fetchWidgets: () => Promise<void>,
  setWidgets: (
    widgets: WidgetItem[] | ((prev: WidgetItem[]) => WidgetItem[]),
  ) => void,
) {
  const [savingStates, setSavingStates] = useState<Record<string, boolean>>({});
  const [isActionLoading, setIsActionLoading] = useState(false);

  const handleUpdate = async (widgetId: string, data: Partial<WidgetItem>) => {
    setSavingStates((prev) => ({ ...prev, [widgetId]: true }));
    try {
      const updatedWidget = await updateWidget({ data: { ...data, id: widgetId } }) as WidgetItem;
      setWidgets((prev) =>
        prev.map((w) => (w.id === widgetId ? { ...w, ...updatedWidget } : w)),
      );
      toast.success("Success", { description: "Widget updated successfully." });
    } catch (error: unknown) {
      console.error("Error updating widget:", error);
      toast.error("Error", { description: getServerFnError(error, "Failed to update widget.") });
    } finally {
      setSavingStates((prev) => ({ ...prev, [widgetId]: false }));
    }
  };

  const handleDelete = async (
    widgetId: string,
    _widgetName: string,
    isPermanent: boolean,
  ) => {
    setIsActionLoading(true);
    try {
      await deleteWidget({ data: { id: widgetId } });
      setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
      toast.success("Success", { description: isPermanent
          ? "Widget permanently deleted."
          : "Widget moved to trash." });
    } catch (error: unknown) {
      console.error("Error deleting widget:", error);
      toast.error("Error", { description: getServerFnError(error, "Failed to delete widget.") });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRestore = async (widgetId: string) => {
    setIsActionLoading(true);
    setSavingStates((prev) => ({ ...prev, [widgetId]: true }));
    try {
      await restoreWidget({ data: { id: widgetId } });
      setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
      toast.success("Success", { description: "Widget restored successfully." });
    } catch (error: unknown) {
      console.error("Error restoring widget:", error);
      toast.error("Error", { description: getServerFnError(error, "Failed to restore widget.") });
    } finally {
      setIsActionLoading(false);
      setSavingStates((prev) => ({ ...prev, [widgetId]: false }));
    }
  };

  return {
    savingStates,
    isActionLoading,
    handleUpdate,
    handleDelete,
    handleRestore,
  };
}
