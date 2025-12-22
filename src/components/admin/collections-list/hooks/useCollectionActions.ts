// src/components/admin/collections-list/hooks/useCollectionActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import type { CollectionItem } from "../types";

export function useCollectionActions(
  onRefresh: () => void,
  setCollections: React.Dispatch<React.SetStateAction<CollectionItem[]>>,
) {
  const [savingStates, setSavingStates] = useState<Record<string, boolean>>({});
  const [isActionLoading, setIsActionLoading] = useState(false);

  const handleUpdate = useCallback(
    async (id: string, data: Partial<CollectionItem>) => {
      setSavingStates((prev) => ({ ...prev, [id]: true }));
      try {
        const response = await fetch(`/api/collections/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to update collection");
        }
        toast.success("Collection updated.");
        setCollections((prev) =>
          prev.map((collection) =>
            collection.id === id ? { ...collection, ...data } : collection,
          ),
        );
      } catch (error: any) {
        toast.error(error.message);
        onRefresh();
      } finally {
        setSavingStates((prev) => ({ ...prev, [id]: false }));
      }
    },
    [onRefresh, setCollections],
  );

  const handleDelete = useCallback(
    async (id: string, name: string, showTrashed: boolean) => {
      setIsActionLoading(true);
      const apiEndpoint = showTrashed
        ? `/api/collections/${id}/permanent`
        : `/api/collections/${id}`;
      const successMessage = showTrashed
        ? `Collection "${name}" permanently deleted.`
        : `Collection "${name}" moved to trash.`;

      try {
        const response = await fetch(apiEndpoint, { method: "DELETE" });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMessage =
            errorData.message ||
            `Failed to delete collection. Status: ${response.status}`;
          throw new Error(errorMessage);
        }

        toast.success(successMessage);
        onRefresh();
      } catch (error: any) {
        toast.error("Deletion Failed", {
          description: error.message,
          duration: 8000,
        });
      } finally {
        setIsActionLoading(false);
      }
    },
    [onRefresh],
  );

  const handleRestore = useCallback(
    async (id: string) => {
      setIsActionLoading(true);
      try {
        const response = await fetch(`/api/collections/${id}/restore`, {
          method: "POST",
        });
        if (!response.ok) throw new Error("Failed to restore collection");
        toast.success("Collection restored.");
        onRefresh();
      } catch (error: any) {
        toast.error(error.message);
      } finally {
        setIsActionLoading(false);
      }
    },
    [onRefresh],
  );

  const handleReorder = useCallback(
    async (updatedOrder: { id: string; sortOrder: number }[]) => {
      try {
        const response = await fetch("/api/collections/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updatedOrder),
        });

        if (!response.ok) {
          throw new Error("Failed to update collection order");
        }

        toast.success("Collection order updated.");
      } catch (error: any) {
        toast.error(error.message);
        throw error;
      }
    },
    [],
  );

  return {
    savingStates,
    isActionLoading,
    handleUpdate,
    handleDelete,
    handleRestore,
    handleReorder,
  };
}
