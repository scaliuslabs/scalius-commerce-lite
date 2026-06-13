// src/components/admin/attributes-manager/hooks/useAttributeActions.ts
import { useCallback } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import {
  updateAttribute,
  createAttribute,
  deleteAttribute,
  deleteAttributePermanent,
  restoreAttribute,
} from "~/lib/api-functions/attributes";
import type { Attribute, NewAttribute } from "../types";

export function useAttributeActions(
  onRefresh: () => void,
  setAttributes: React.Dispatch<React.SetStateAction<Attribute[]>>,
) {
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Attribute> }) =>
      updateAttribute({ data: { id, ...data } }),
    onMutate: async ({ id, data }) => {
      setAttributes((prev) =>
        prev.map((attr) => (attr.id === id ? { ...attr, ...data } : attr)),
      );
    },
    onSuccess: () => {
      toast.success("Attribute updated.");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Failed to update attribute"));
      onRefresh();
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["attributes"] });
    },
  });

  const createMutation = useMutation({
    mutationFn: (newAttribute: NewAttribute) =>
      createAttribute({ data: newAttribute }),
    onSuccess: (_data, newAttribute) => {
      toast.success(`Attribute "${newAttribute.name}" created successfully.`);
      onRefresh();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Failed to create attribute"));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["attributes"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, showTrashed }: { id: string; name: string; showTrashed: boolean }) =>
      showTrashed
        ? deleteAttributePermanent({ data: { id } })
        : deleteAttribute({ data: { id } }),
    onSuccess: (_data, { name, showTrashed }) => {
      toast.success(
        showTrashed
          ? `Attribute "${name}" permanently deleted.`
          : `Attribute "${name}" moved to trash.`,
      );
      onRefresh();
    },
    onError: (error) => {
      toast.error("Deletion Failed", {
        description: getServerFnError(error, "Failed to delete attribute"),
        duration: 8000,
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["attributes"] });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => restoreAttribute({ data: { id } }),
    onSuccess: () => {
      toast.success("Attribute restored.");
      onRefresh();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Failed to restore attribute"));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["attributes"] });
    },
  });

  const savingStates: Record<string, boolean> = {};
  if (updateMutation.isPending && updateMutation.variables) {
    savingStates[updateMutation.variables.id] = true;
  }

  const isActionLoading =
    deleteMutation.isPending || restoreMutation.isPending;

  const handleUpdate = useCallback(
    (id: string, data: Partial<Attribute>) => {
      updateMutation.mutate({ id, data });
    },
    [updateMutation],
  );

  const handleCreate = useCallback(
    (newAttribute: NewAttribute, onSuccess: () => void) => {
      if (!newAttribute.name.trim() || !newAttribute.slug.trim()) {
        toast.error("Name and slug are required.");
        return;
      }
      createMutation.mutate(newAttribute, {
        onSuccess: () => onSuccess(),
      });
    },
    [createMutation],
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

  return {
    savingStates,
    isActionLoading,
    isCreating: createMutation.isPending,
    handleUpdate,
    handleCreate,
    handleDelete,
    handleRestore,
  };
}
