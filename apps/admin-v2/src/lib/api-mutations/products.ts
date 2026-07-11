import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  applyProductVariantEditPlan,
  bulkCreateProductVariants,
  bulkDeleteProducts,
  bulkDeleteProductVariants,
  createProduct,
  createProductVariant,
  deleteProduct,
  deleteProductVariant,
  permanentDeleteProduct,
  restoreProduct,
  updateProduct,
  updateProductVariant,
  type BulkProductVariantInput,
  type BulkDeleteProductsInput,
  type CreateProductInput,
  type ProductVariantInput,
  type ProductVariantEditPlanInput,
  type ProductVariantEditPlanPayload,
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
  queryClient.invalidateQueries({
    queryKey: queryKeys.products.variantSortOrder(productId),
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
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      toast.success(
        variables.permanent
          ? `${variables.products.length} products permanently deleted`
          : `${variables.products.length} products moved to trash`,
      );
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

export function useBulkCreateProductVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variants: BulkProductVariantInput[];
      expectedAggregateRevision: number;
    }) => bulkCreateProductVariants({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("Options created");
    },
    onError: (err) =>
      toastUnlessProductRevisionConflict(err, "Failed to create options"),
  });
}

export function useApplyProductVariantEditPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      plan: ProductVariantEditPlanInput;
      expectedAggregateRevision: number;
    }): Promise<ProductVariantEditPlanPayload> =>
      applyProductVariantEditPlan({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("Option changes saved");
    },
    onError: (err) =>
      toastUnlessProductRevisionConflict(err, "Failed to save option changes"),
  });
}

export function useBulkDeleteProductVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variantIds: string[];
      expectedAggregateRevision: number;
    }) =>
      bulkDeleteProductVariants({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success(`${variables.variantIds.length} options deleted`);
    },
    onError: (err) =>
      toastUnlessProductRevisionConflict(err, "Failed to delete options"),
  });
}
