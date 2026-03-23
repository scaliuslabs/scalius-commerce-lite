// src/components/admin/pages-list/hooks/usePageActions.ts
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { getServerFnError } from "@/lib/api-helpers";
import { deletePage, permanentDeletePage, restorePage } from "@/lib/api.functions";

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
        if (showTrashed) {
          await permanentDeletePage({ data: { id } });
        } else {
          await deletePage({ data: { id } });
        }
        toast.success(successMessage);
        fetchPages();
      } catch (error: unknown) {
        toast.error("Deletion Failed", {
          description: getServerFnError(error, "Failed to delete page"),
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
        await restorePage({ data: { id } });
        toast.success("Page restored.");
        fetchPages();
      } catch (error: unknown) {
        toast.error(getServerFnError(error, "Failed to restore page"));
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
