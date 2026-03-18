// src/components/admin/widget-list/hooks/useWidgetActions.ts
import { useState } from "react";
import { toast } from "sonner";
import type { WidgetItem } from "../types";
import { unwrapEnvelope, extractApiError } from "@/lib/api-helpers";

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
      const response = await fetch(`/api/v1/admin/widgets/${widgetId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(extractApiError(errorJson, "Failed to update widget"));
      }

      const json = await response.json();
      const updatedWidget = unwrapEnvelope(json);
      setWidgets((prev) =>
        prev.map((w) => (w.id === widgetId ? { ...w, ...updatedWidget } : w)),
      );

      toast.success("Success", { description: "Widget updated successfully." });
    } catch (error: unknown) {
      console.error("Error updating widget:", error);
      toast.error("Error", { description: error instanceof Error ? error.message : "Failed to update widget." });
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
      const url = isPermanent
        ? `/api/v1/admin/widgets/${widgetId}/permanent`
        : `/api/v1/admin/widgets/${widgetId}`;

      const response = await fetch(url, { method: "DELETE" });

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(extractApiError(errorJson, "Failed to delete widget"));
      }

      setWidgets((prev) => prev.filter((w) => w.id !== widgetId));

      toast.success("Success", { description: isPermanent
          ? "Widget permanently deleted."
          : "Widget moved to trash." });
    } catch (error: unknown) {
      console.error("Error deleting widget:", error);
      toast.error("Error", { description: error instanceof Error ? error.message : "Failed to delete widget." });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRestore = async (widgetId: string) => {
    setIsActionLoading(true);
    setSavingStates((prev) => ({ ...prev, [widgetId]: true }));
    try {
      const response = await fetch(`/api/v1/admin/widgets/${widgetId}/restore`, {
        method: "POST",
      });

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(extractApiError(errorJson, "Failed to restore widget"));
      }

      setWidgets((prev) => prev.filter((w) => w.id !== widgetId));

      toast.success("Success", { description: "Widget restored successfully." });
    } catch (error: unknown) {
      console.error("Error restoring widget:", error);
      toast.error("Error", { description: error instanceof Error ? error.message : "Failed to restore widget." });
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
