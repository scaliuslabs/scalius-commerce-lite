import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkCreateProductVariants,
  bulkDeleteProducts,
  bulkDeleteProductVariants,
  bulkUpdateProductVariants,
  createProduct,
  createProductVariant,
  deleteProduct,
  deleteProductVariant,
  duplicateProductVariant,
  permanentDeleteProduct,
  restoreProduct,
  updateProduct,
  updateProductVariant,
  type BulkProductVariantInput,
  type CreateProductInput,
  type ProductVariantInput,
  type ProductVariantUpdateInput,
  type UpdateProductInput,
} from "../api-functions/products";
import {
  getServerFnError,
  invalidateDashboardQueries,
  invalidateProductLookupQueries,
  invalidateProductStatsQueries,
  queryKeys,
} from "./shared";

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
    mutationFn: (id: string) => deleteProduct({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.products.detail(id) });
      toast.success("Product moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete product")),
  });
}

export function usePermanentDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteProduct({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.products.detail(id) });
      toast.success("Product permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete product"),
      ),
  });
}

export function useRestoreProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreProduct({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(id),
      });
      toast.success("Product restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore product")),
  });
}

export function useBulkDeleteProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { productIds: string[]; permanent?: boolean }) =>
      bulkDeleteProducts({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductLookupQueries(queryClient);
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      toast.success(
        variables.permanent
          ? `${variables.productIds.length} products permanently deleted`
          : `${variables.productIds.length} products moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete products")),
  });
}

export function useCreateProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variant: ProductVariantInput;
    }) => createProductVariant({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("Option created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create option")),
  });
}

export function useUpdateProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variantId: string;
      variant: ProductVariantInput;
    }) => updateProductVariant({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("SKU saved");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to save SKU")),
  });
}

export function useDeleteProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { productId: string; variantId: string }) =>
      deleteProductVariant({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("Option deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete option")),
  });
}

export function useBulkCreateProductVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variants: BulkProductVariantInput[];
    }) => bulkCreateProductVariants({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("Options created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create options")),
  });
}

export function useBulkUpdateProductVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      updates: ProductVariantUpdateInput[];
    }) => bulkUpdateProductVariants({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("Options updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update options")),
  });
}

export function useBulkDeleteProductVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { productId: string; variantIds: string[] }) =>
      bulkDeleteProductVariants({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success(`${variables.variantIds.length} options deleted`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete options")),
  });
}

export function useDuplicateProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { productId: string; variantId: string }) =>
      duplicateProductVariant({ data }),
    onSuccess: (_data, variables) => {
      invalidateProductVariantMutationQueries(queryClient, variables.productId);
      toast.success("Option duplicated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to duplicate option")),
  });
}
