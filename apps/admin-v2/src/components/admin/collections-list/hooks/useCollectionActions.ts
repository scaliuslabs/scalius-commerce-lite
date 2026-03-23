// src/components/admin/collections-list/hooks/useCollectionActions.ts
import { useCallback } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CollectionItem> }) =>
      updateCollection({ data: { id, ...data } }),
    onMutate: async ({ id, data }) => {
      setCollections((prev) =>
        prev.map((collection) =>
          collection.id === id ? { ...collection, ...data } : collection,
        ),
      );
    },
    onSuccess: () => {
      toast.success("Collection updated.");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Failed to update collection"));
      onRefresh();
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, showTrashed }: { id: string; name: string; showTrashed: boolean }) =>
      showTrashed
        ? deleteCollectionPermanent({ data: { id } })
        : deleteCollection({ data: { id } }),
    onSuccess: (_data, { name, showTrashed }) => {
      toast.success(
        showTrashed
          ? `Collection "${name}" permanently deleted.`
          : `Collection "${name}" moved to trash.`,
      );
      onRefresh();
    },
    onError: (error) => {
      toast.error("Deletion Failed", {
        description: getServerFnError(error, "Failed to delete collection"),
        duration: 8000,
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => restoreCollection({ data: { id } }),
    onSuccess: () => {
      toast.success("Collection restored.");
      onRefresh();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Failed to restore collection"));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (updatedOrder: { id: string; sortOrder: number }[]) =>
      reorderCollections({ data: { items: updatedOrder } }),
    onSuccess: () => {
      toast.success("Collection order updated.");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Failed to update collection order"));
      onRefresh();
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
  });

  const savingStates: Record<string, boolean> = {};
  if (updateMutation.isPending && updateMutation.variables) {
    savingStates[updateMutation.variables.id] = true;
  }

  const isActionLoading =
    deleteMutation.isPending || restoreMutation.isPending;

  const handleUpdate = useCallback(
    (id: string, data: Partial<CollectionItem>) => {
      updateMutation.mutate({ id, data });
    },
    [updateMutation],
  );

  const handleDelete = useCallback(
    (id: string, name: string, showTrashed: boolean) => {
      deleteMutation.mutate({ id, name, showTrashed });
    },
    [deleteMutation],
  );

  const handleRestore = useCallback(
    (id: string) => {
      restoreMutation.mutate(id);
    },
    [restoreMutation],
  );

  const handleReorder = useCallback(
    async (updatedOrder: { id: string; sortOrder: number }[]) => {
      reorderMutation.mutate(updatedOrder);
    },
    [reorderMutation],
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
