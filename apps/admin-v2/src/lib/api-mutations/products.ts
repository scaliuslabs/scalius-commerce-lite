import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminProductsById,
  deleteApiV1AdminProductsByIdPermanent,
  postApiV1AdminProductsBulkDelete,
  postApiV1AdminProductsByIdRestore,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";
import type { ProductAggregateRevisionClaim } from "../api-query-options/products";
import {
  getServerFnError,
  invalidateDashboardQueries,
  invalidateProductLookupQueries,
  invalidateProductStatsQueries,
  queryKeys,
} from "./shared";
import { readProductRevisionConflict } from "../admin-api-error";

function handleProductListMutationError(
  queryClient: QueryClient,
  error: unknown,
  fallback: string,
) {
  if (readProductRevisionConflict(error)) {
    queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
    toast.error("Product changed", {
      description: "The product list is refreshing. Try again.",
    });
    return;
  }
  toast.error(getServerFnError(error, fallback));
}

export function useDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedAggregateRevision }: ProductAggregateRevisionClaim) =>
      apiData(deleteApiV1AdminProductsById({ path: { id }, query: { expectedAggregateRevision } })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.products.detail(variables.id) });
      toast.success("Product moved to trash");
    },
    onError: (err) =>
      handleProductListMutationError(
        queryClient,
        err,
        "Failed to delete product",
      ),
  });
}

export function usePermanentDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedAggregateRevision }: ProductAggregateRevisionClaim) =>
      apiData(deleteApiV1AdminProductsByIdPermanent({
        path: { id },
        query: { expectedAggregateRevision },
      })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.products.detail(variables.id) });
      toast.success("Product permanently deleted");
    },
    onError: (err) =>
      handleProductListMutationError(
        queryClient,
        err,
        "Failed to permanently delete product",
      ),
  });
}

export function useRestoreProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedAggregateRevision }: ProductAggregateRevisionClaim) =>
      apiData(postApiV1AdminProductsByIdRestore({ path: { id }, query: { expectedAggregateRevision } })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.id),
      });
      toast.success("Product restored");
    },
    onError: (err) =>
      handleProductListMutationError(
        queryClient,
        err,
        "Failed to restore product",
      ),
  });
}

export function useBulkDeleteProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiBody<typeof postApiV1AdminProductsBulkDelete>) =>
      apiData(postApiV1AdminProductsBulkDelete({ body })),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      if (!variables.permanent) {
        toast.success(`${variables.products.length} products moved to trash`);
        return;
      }

      const blocked = data.outcomes.filter(
        (outcome) => outcome.status === "blocked" || outcome.status === "failed",
      );
      if (blocked.length === 0) {
        toast.success(`${data.deletedIds.length} products permanently deleted`);
        return;
      }

      const firstMessage = blocked.find((outcome) => outcome.message)?.message;
      const summary = `${data.deletedIds.length} deleted; ${blocked.length} kept in trash.`;
      if (data.deletedIds.length === 0) {
        toast.error("No products were permanently deleted", {
          description: firstMessage ?? summary,
        });
      } else {
        toast.warning("Permanent delete completed with issues", {
          description: firstMessage ? `${summary} ${firstMessage}` : summary,
        });
      }
    },
    onError: (err) =>
      handleProductListMutationError(
        queryClient,
        err,
        "Failed to delete products",
      ),
  });
}
