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
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";

const t = (key: ProductMessageKey, vars?: Record<string, string | number>) =>
  translate(productMessages, key, vars);

function handleProductListMutationError(queryClient: QueryClient, error: unknown) {
  if (readProductRevisionConflict(error)) {
    queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
    toast.error(t("listChangedTitle"), { description: t("listChangedBody") });
    return;
  }
  toast.error(getServerFnError(error, translate(resourceMessages, "actionFailed")));
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
      toast.success(t("movedToTrash"));
    },
    onError: (err) => handleProductListMutationError(queryClient, err),
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
      toast.success(t("deleted"));
    },
    onError: (err) => handleProductListMutationError(queryClient, err),
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
      toast.success(t("restored"));
    },
    onError: (err) => handleProductListMutationError(queryClient, err),
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
        toast.success(t("bulkMovedToTrash", { count: variables.products.length }));
        return;
      }

      const blocked = data.outcomes.filter(
        (outcome) => outcome.status === "blocked" || outcome.status === "failed",
      );
      if (blocked.length === 0) {
        toast.success(t("bulkDeleted", { count: data.deletedIds.length }));
        return;
      }

      // The server explains why (e.g. a variant has stock history); show it as sent.
      const firstMessage = blocked.find((outcome) => outcome.message)?.message;
      const summary = t("bulkDeletePartial", { deleted: data.deletedIds.length, kept: blocked.length });
      if (data.deletedIds.length === 0) {
        toast.error(t("bulkDeleteNone"), { description: firstMessage ?? summary });
      } else {
        toast.warning(summary, { description: firstMessage });
      }
    },
    onError: (err) => handleProductListMutationError(queryClient, err),
  });
}
