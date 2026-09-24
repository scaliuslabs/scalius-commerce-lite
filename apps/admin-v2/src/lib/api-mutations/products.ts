import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  deleteApiV1AdminProductsById,
  postApiV1AdminProductsByIdDuplicate,
} from "@scalius/api-client/sdk";
import { apiData } from "../api";
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

const t = (key: ProductMessageKey, vars?: Record<string, string | number>) =>
  translate(productMessages, key, vars);

function toastProductError(error: unknown) {
  if (readProductRevisionConflict(error)) {
    toast.error(t("listChangedTitle"), { description: t("listChangedBody") });
    return;
  }
  toast.error(getServerFnError(error, t("saveFailed")));
}

/** Moves one product to trash from its page, then returns to the list. */
export function useTrashProduct() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: ({ id, expectedAggregateRevision }: ProductAggregateRevisionClaim) =>
      apiData(deleteApiV1AdminProductsById({ path: { id }, query: { expectedAggregateRevision } })),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.products.detail(variables.id) });
      toast.success(t("movedToTrash"));
      // The product is gone from this page; unsaved edits to it can't be kept.
      void navigate({ to: "/admin/products", ignoreBlocker: true });
    },
    onError: toastProductError,
  });
}

/** Copies a product as a draft ("Copy of …") and opens the copy. */
export function useDuplicateProduct() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiData(postApiV1AdminProductsByIdDuplicate({
        path: { id },
        body: { name: t("copyOf", { name }).slice(0, 100) },
      })),
    onSuccess: (copy) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductStatsQueries(queryClient);
      toast.success(t("duplicated"));
      void navigate({ to: "/admin/products/$productId/edit", params: { productId: copy.id } });
    },
    onError: toastProductError,
  });
}
