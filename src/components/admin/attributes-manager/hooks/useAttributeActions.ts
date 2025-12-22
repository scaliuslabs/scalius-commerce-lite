// src/components/admin/attributes-manager/hooks/useAttributeActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import type { Attribute, NewAttribute } from "../types";

export function useAttributeActions(
  onRefresh: () => void,
  setAttributes: React.Dispatch<React.SetStateAction<Attribute[]>>,
) {
  const [savingStates, setSavingStates] = useState<Record<string, boolean>>({});
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const handleUpdate = useCallback(
    async (id: string, data: Partial<Attribute>) => {
      setSavingStates((prev) => ({ ...prev, [id]: true }));
      try {
        const response = await fetch(`/api/admin/attributes/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to update attribute");
        }
        toast.success(`Attribute updated.`);
        setAttributes((prev) =>
          prev.map((attr) => (attr.id === id ? { ...attr, ...data } : attr)),
        );
      } catch (error: any) {
        toast.error(error.message);
        onRefresh();
      } finally {
        setSavingStates((prev) => ({ ...prev, [id]: false }));
      }
    },
    [onRefresh, setAttributes],
  );

  const handleCreate = useCallback(
    async (newAttribute: NewAttribute, onSuccess: () => void) => {
      if (!newAttribute.name.trim() || !newAttribute.slug.trim()) {
        toast.error("Name and slug are required.");
        return;
      }
      setIsCreating(true);
      try {
        const response = await fetch("/api/admin/attributes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newAttribute),
        });
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to create attribute");
        }
        toast.success(`Attribute "${newAttribute.name}" created successfully.`);
        onSuccess();
        onRefresh();
      } catch (error: any) {
        toast.error(error.message);
      } finally {
        setIsCreating(false);
      }
    },
    [onRefresh],
  );

  const handleDelete = useCallback(
    async (id: string, name: string, showTrashed: boolean) => {
      setIsActionLoading(true);
      const apiEndpoint = showTrashed
        ? `/api/admin/attributes/${id}/permanent`
        : `/api/admin/attributes/${id}`;
      const successMessage = showTrashed
        ? `Attribute "${name}" permanently deleted.`
        : `Attribute "${name}" moved to trash.`;

      try {
        const response = await fetch(apiEndpoint, { method: "DELETE" });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMessage =
            errorData.message ||
            `Failed to delete attribute. Status: ${response.status}`;
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
        await fetch(`/api/admin/attributes/${id}/restore`, { method: "POST" });
        toast.success("Attribute restored.");
        onRefresh();
      } catch (error: any) {
        toast.error(error.message);
      } finally {
        setIsActionLoading(false);
      }
    },
    [onRefresh],
  );

  return {
    savingStates,
    isActionLoading,
    isCreating,
    handleUpdate,
    handleCreate,
    handleDelete,
    handleRestore,
  };
}
