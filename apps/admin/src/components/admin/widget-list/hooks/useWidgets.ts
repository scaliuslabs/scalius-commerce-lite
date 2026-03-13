// src/components/admin/widget-list/hooks/useWidgets.ts
import { useState, useEffect } from "react";
import type { WidgetItem, CollectionOption, WidgetStatistics } from "../types";

export function useWidgets(
  initialWidgets: WidgetItem[],
  initialCollections: CollectionOption[],
  initialStats: WidgetStatistics,
  _showTrashed: boolean,
) {
  const [widgets, setWidgets] = useState<WidgetItem[]>(initialWidgets);
  const [collections] = useState<CollectionOption[]>(initialCollections);
  const [stats] = useState<WidgetStatistics>(initialStats);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setWidgets(initialWidgets);
  }, [initialWidgets]);

  const fetchWidgets = async () => {
    setIsLoading(true);
    try {
      // Reload the page to get fresh data from the server
      window.location.reload();
    } catch (error) {
      console.error("Error fetching widgets:", error);
      setIsLoading(false);
    }
  };

  return {
    widgets,
    setWidgets,
    collections,
    stats,
    isLoading,
    fetchWidgets,
  };
}
