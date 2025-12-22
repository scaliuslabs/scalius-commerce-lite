// src/components/admin/widget-list/hooks/useWidgetActions.ts
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import type { WidgetItem } from "../types";

export function useWidgetActions(
  _fetchWidgets: () => Promise<void>,
  setWidgets: (
    widgets: WidgetItem[] | ((prev: WidgetItem[]) => WidgetItem[]),
  ) => void,
) {
  const { toast } = useToast();
  const [savingStates, setSavingStates] = useState<Record<string, boolean>>({});
  const [isActionLoading, setIsActionLoading] = useState(false);

  const handleUpdate = async (widgetId: string, data: Partial<WidgetItem>) => {
    setSavingStates((prev) => ({ ...prev, [widgetId]: true }));
    try {
      const response = await fetch(`/api/widgets/${widgetId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) throw new Error("Failed to update widget");

      const updatedWidget = await response.json();
      setWidgets((prev) =>
        prev.map((w) => (w.id === widgetId ? { ...w, ...updatedWidget } : w)),
      );

      toast({
        title: "Success",
        description: "Widget updated successfully.",
      });
    } catch (error) {
      console.error("Error updating widget:", error);
      toast({
        title: "Error",
        description: "Failed to update widget.",
        variant: "destructive",
      });
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
        ? `/api/widgets/${widgetId}/permanent`
        : `/api/widgets/${widgetId}`;

      const response = await fetch(url, { method: "DELETE" });

      if (!response.ok) throw new Error("Failed to delete widget");

      setWidgets((prev) => prev.filter((w) => w.id !== widgetId));

      toast({
        title: "Success",
        description: isPermanent
          ? "Widget permanently deleted."
          : "Widget moved to trash.",
      });
    } catch (error) {
      console.error("Error deleting widget:", error);
      toast({
        title: "Error",
        description: "Failed to delete widget.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRestore = async (widgetId: string) => {
    setIsActionLoading(true);
    setSavingStates((prev) => ({ ...prev, [widgetId]: true }));
    try {
      const response = await fetch(`/api/widgets/${widgetId}/restore`, {
        method: "POST",
      });

      if (!response.ok) throw new Error("Failed to restore widget");

      setWidgets((prev) => prev.filter((w) => w.id !== widgetId));

      toast({
        title: "Success",
        description: "Widget restored successfully.",
      });
    } catch (error) {
      console.error("Error restoring widget:", error);
      toast({
        title: "Error",
        description: "Failed to restore widget.",
        variant: "destructive",
      });
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
