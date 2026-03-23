import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";

interface UseDeleteHandlerOptions {
  deleteFn: (data: { id: string }) => Promise<unknown>;
  invalidateKeys: readonly (readonly unknown[])[];
  removeKeys?: readonly ((id: string) => readonly unknown[])[];
  successMessage?: string;
  errorMessage?: string;
  /** Whether to call router.invalidate() after success (default false) */
  invalidateRouter?: boolean;
}

export function useDeleteHandler({
  deleteFn,
  invalidateKeys,
  removeKeys,
  successMessage = "Deleted successfully",
  errorMessage = "Failed to delete",
  invalidateRouter = false,
}: UseDeleteHandlerOptions) {
  const [isDeleting, setIsDeleting] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        setIsDeleting(true);
        await deleteFn({ id });
        for (const key of invalidateKeys) {
          queryClient.invalidateQueries({ queryKey: key as unknown[] });
        }
        if (removeKeys) {
          for (const keyFn of removeKeys) {
            queryClient.removeQueries({ queryKey: keyFn(id) as unknown[] });
          }
        }
        toast.success(successMessage);
        if (invalidateRouter) {
          router.invalidate();
        }
      } catch (error) {
        toast.error(getServerFnError(error, errorMessage));
      } finally {
        setIsDeleting(false);
      }
    },
    [deleteFn, invalidateKeys, removeKeys, successMessage, errorMessage, invalidateRouter, queryClient, router],
  );

  return { isDeleting, handleDelete };
}
