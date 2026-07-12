import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteProducts,
  createProduct,
  createProductVariant,
  deleteProduct,
  deleteProductVariant,
  permanentDeleteProduct,
  restoreProduct,
  updateProduct,
  updateProductVariant,
  type BulkDeleteProductsInput,
  type CreateProductInput,
  type ProductVariantInput,
  type UpdateProductInput,
  type ProductAggregateRevisionClaim,
} from "../api-functions/products";
import {
  getServerFnError,
  invalidateDashboardQueries,
  invalidateProductLookupQueries,
  invalidateProductStatsQueries,
  queryKeys,
} from "./shared";
import { readProductRevisionConflict } from "../admin-api-error";

function toastUnlessProductRevisionConflict(error: unknown, fallback: string) {
  if (readProductRevisionConflict(error)) return;
  toast.error(getServerFnError(error, fallback));
}

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

function invalidateProductVariantMutationQueries(
  queryClient: QueryClient,
  productId: string,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
  invalidateProductLookupQueries(queryClient);
  invalidateProductStatsQueries(queryClient);
  queryClient.invalidateQueries({
    queryKey: queryKeys.products.detail(productId),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.products.variants(productId),
  });
  queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list() });
}

export function useCreateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProductInput) => createProduct({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      toast.success("Product created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create product")),
  });
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateProductInput) => updateProduct({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.id),
      });
      toast.success("Product updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update product")),
  });
}

export function useDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ProductAggregateRevisionClaim) => deleteProduct({ data }),
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
    mutationFn: (data: ProductAggregateRevisionClaim) =>
      permanentDeleteProduct({ data }),
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
    mutationFn: (data: ProductAggregateRevisionClaim) => restoreProduct({ data }),
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
    mutationFn: (data: BulkDeleteProductsInput) =>
      bulkDeleteProducts({ data }),
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

export function useCreateProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variant: ProductVariantInput;
      expectedAggregateRevision: number;
    }) => createProductVariant({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("Option created");
    },
    onError: (err) =>
      toastUnlessProductRevisionConflict(err, "Failed to create option"),
  });
}

export function useUpdateProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variantId: string;
      variant: ProductVariantInput;
      expectedAggregateRevision: number;
    }) => updateProductVariant({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("SKU saved");
    },
    onError: (err) =>
      toastUnlessProductRevisionConflict(err, "Failed to save SKU"),
  });
}

export function useDeleteProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variantId: string;
      expectedAggregateRevision: number;
    }) =>
      deleteProductVariant({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("Option deleted");
    },
    onError: (err) =>
      toastUnlessProductRevisionConflict(err, "Failed to delete option"),
  });
}
