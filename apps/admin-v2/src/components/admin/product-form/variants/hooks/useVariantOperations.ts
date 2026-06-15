// src/components/admin/ProductForm/variants/hooks/useVariantOperations.ts

import type { ProductVariant, VariantFormValues, BulkGeneratedVariant } from "../types";
import {
  useCreateProductVariant,
  useUpdateProductVariant,
  useDeleteProductVariant,
  useBulkDeleteProductVariants,
  useBulkCreateProductVariants,
  useBulkUpdateProductVariants,
  useDuplicateProductVariant,
} from "@/lib/api-mutations/products";

function toProductVariant(result: unknown): ProductVariant {
  const r = result as Record<string, unknown>;
  return {
    ...r,
    createdAt: new Date(r.createdAt as string),
    updatedAt: new Date(r.updatedAt as string),
    deletedAt: r.deletedAt ? new Date(r.deletedAt as string) : null,
  } as ProductVariant;
}

export interface UseVariantOperationsReturn {
  createVariant: (
    productId: string,
    values: VariantFormValues
  ) => Promise<ProductVariant | null>;
  updateVariant: (
    productId: string,
    variantId: string,
    values: VariantFormValues
  ) => Promise<ProductVariant | null>;
  deleteVariant: (productId: string, variantId: string) => Promise<boolean>;
  bulkDeleteVariants: (productId: string, variantIds: string[]) => Promise<boolean>;
  bulkCreateVariants: (
    productId: string,
    variants: BulkGeneratedVariant[]
  ) => Promise<ProductVariant[]>;
  bulkUpdateVariants: (
    productId: string,
    updates: Array<{
      id: string;
      size?: string | null;
      color?: string | null;
      weight?: number | null;
      sku?: string;
      price?: number;
      stock?: number;
    }>
  ) => Promise<boolean>;
  duplicateVariant: (productId: string, variantId: string) => Promise<ProductVariant | null>;
  isLoading: boolean;
}

export function useVariantOperations(): UseVariantOperationsReturn {
  const createMutation = useCreateProductVariant();
  const updateMutation = useUpdateProductVariant();
  const deleteMutation = useDeleteProductVariant();
  const bulkDeleteMutation = useBulkDeleteProductVariants();
  const bulkCreateMutation = useBulkCreateProductVariants();
  const bulkUpdateMutation = useBulkUpdateProductVariants();
  const duplicateMutation = useDuplicateProductVariant();

  const isLoading =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    bulkDeleteMutation.isPending ||
    bulkCreateMutation.isPending ||
    bulkUpdateMutation.isPending ||
    duplicateMutation.isPending;

  const createVariant = async (
    productId: string,
    values: VariantFormValues
  ): Promise<ProductVariant | null> => {
    try {
      const result = await createMutation.mutateAsync({
        productId,
        variant: values,
      });
      return toProductVariant(result);
    } catch {
      // Error toast is handled by the mutation's onError
      return null;
    }
  };

  const updateVariant = async (
    productId: string,
    variantId: string,
    values: VariantFormValues
  ): Promise<ProductVariant | null> => {
    try {
      const result = await updateMutation.mutateAsync({
        productId,
        variantId,
        variant: values,
      });
      return toProductVariant(result);
    } catch {
      return null;
    }
  };

  const deleteVariant = async (productId: string, variantId: string): Promise<boolean> => {
    try {
      await deleteMutation.mutateAsync({ productId, variantId });
      return true;
    } catch {
      return false;
    }
  };

  const bulkDeleteVariants = async (
    productId: string,
    variantIds: string[]
  ): Promise<boolean> => {
    try {
      await bulkDeleteMutation.mutateAsync({ productId, variantIds });
      return true;
    } catch {
      return false;
    }
  };

  const bulkUpdateVariants = async (
    productId: string,
    updates: Array<{
      id: string;
      size?: string | null;
      color?: string | null;
      weight?: number | null;
      sku?: string;
      price?: number;
      stock?: number;
    }>
  ): Promise<boolean> => {
    try {
      await bulkUpdateMutation.mutateAsync({
        productId,
        updates,
      });
      return true;
    } catch {
      return false;
    }
  };

  const bulkCreateVariants = async (
    productId: string,
    variants: BulkGeneratedVariant[]
  ): Promise<ProductVariant[]> => {
    try {
      const result = await bulkCreateMutation.mutateAsync({
        productId,
        variants,
      });
      const savedVariants = result.variants.map((variant) =>
        toProductVariant(variant),
      );
      return savedVariants;
    } catch {
      return [];
    }
  };

  const duplicateVariant = async (
    productId: string,
    variantId: string
  ): Promise<ProductVariant | null> => {
    try {
      const result = await duplicateMutation.mutateAsync({ productId, variantId });
      return toProductVariant(result);
    } catch {
      return null;
    }
  };

  return {
    createVariant,
    updateVariant,
    deleteVariant,
    bulkDeleteVariants,
    bulkUpdateVariants,
    bulkCreateVariants,
    duplicateVariant,
    isLoading,
  };
}
