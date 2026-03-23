// src/components/admin/collections-list/hooks/useCollectionActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import {
  updateCollection,
  deleteCollection,
  deleteCollectionPermanent,
  restoreCollection,
  reorderCollections,
} from "~/lib/api.functions";
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
        await updateCollection({ data: { id, ...data } });
        toast.success("Collection updated.");
        setCollections((prev) =>
          prev.map((collection) =>
            collection.id === id ? { ...collection, ...data } : collection,
          ),
        );
      } catch (error: unknown) {
        toast.error(getServerFnError(error, "Failed to update collection"));
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
      const successMessage = showTrashed
        ? `Collection "${name}" permanently deleted.`
        : `Collection "${name}" moved to trash.`;

      try {
        if (showTrashed) {
          await deleteCollectionPermanent({ data: { id } });
        } else {
          await deleteCollection({ data: { id } });
        }

        toast.success(successMessage);
        onRefresh();
      } catch (error: unknown) {
        toast.error("Deletion Failed", {
          description: getServerFnError(error, "Failed to delete collection"),
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
        await restoreCollection({ data: { id } });
        toast.success("Collection restored.");
        onRefresh();
      } catch (error: unknown) {
        toast.error(getServerFnError(error, "Failed to restore collection"));
      } finally {
        setIsActionLoading(false);
      }
    },
    [onRefresh],
  );

  const handleReorder = useCallback(
    async (updatedOrder: { id: string; sortOrder: number }[]) => {
      try {
        await reorderCollections({ data: { items: updatedOrder } });
        toast.success("Collection order updated.");
      } catch (error: unknown) {
        toast.error(getServerFnError(error, "Failed to update collection order"));
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
