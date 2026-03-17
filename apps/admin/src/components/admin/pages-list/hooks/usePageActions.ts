// src/components/admin/pages-list/hooks/usePageActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";

export function usePageActions(fetchPages: () => void) {
  const [isActionLoading, setIsActionLoading] = useState(false);

  const handleDelete = useCallback(
    async (id: string, title: string, showTrashed: boolean) => {
      setIsActionLoading(true);
      const apiEndpoint = showTrashed
        ? `/api/v1/admin/pages/${id}/permanent`
        : `/api/v1/admin/pages/${id}`;
      const successMessage = showTrashed
        ? `Page "${title}" permanently deleted.`
        : `Page "${title}" moved to trash.`;

      try {
        const response = await fetch(apiEndpoint, { method: "DELETE" });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMessage =
            errorData.message ||
            `Failed to delete page. Status: ${response.status}`;
          throw new Error(errorMessage);
        }
        toast.success(successMessage);
        fetchPages();
      } catch (error: unknown) {
        toast.error("Deletion Failed", {
          description: (error instanceof Error ? error.message : String(error)),
          duration: 8000,
        });
      } finally {
        setIsActionLoading(false);
      }
    },
    [fetchPages],
  );

  const handleRestore = useCallback(
    async (id: string) => {
      setIsActionLoading(true);
      try {
        const response = await fetch(`/api/v1/admin/pages/${id}/restore`, {
          method: "POST",
        });
        if (!response.ok) {
          throw new Error("Failed to restore page");
        }
        toast.success("Page restored.");
        fetchPages();
      } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setIsActionLoading(false);
      }
    },
    [fetchPages],
  );

  return {
    isActionLoading,
    handleDelete,
    handleRestore,
  };
}
