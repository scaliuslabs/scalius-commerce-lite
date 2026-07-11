// src/components/admin/ProductForm/variants/hooks/useVariantOperations.ts

import type { ProductVariant, VariantFormValues, BulkGeneratedVariant } from "../types";
import {
  useCreateProductVariant,
  useUpdateProductVariant,
  useDeleteProductVariant,
  useBulkDeleteProductVariants,
  useBulkCreateProductVariants,
  useApplyProductVariantEditPlan,
} from "@/lib/api-mutations/products";
import {
  readProductRevisionConflict,
  type ProductRevisionConflict,
} from "@/lib/admin-api-error";

type VariantEditPlanUpdate = {
  id: string;
  size?: string | null;
  color?: string | null;
  weight?: number | null;
  sku?: string;
  price?: number;
  stock?: number;
  trackInventory?: boolean;
};

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
  applyVariantEditPlan: (
    productId: string,
    creates: BulkGeneratedVariant[],
    updates: VariantEditPlanUpdate[],
  ) => Promise<{ created: ProductVariant[]; updated: ProductVariant[] } | null>;
  isLoading: boolean;
}

interface UseVariantOperationsOptions {
  aggregateRevision: number;
  revisionConflict: ProductRevisionConflict | null;
  onAggregateRevisionChange: (revision: number) => void;
  onRevisionConflict: (conflict: ProductRevisionConflict) => void;
  onOpenRevisionConflict: () => void;
}

export function useVariantOperations({
  aggregateRevision,
  revisionConflict,
  onAggregateRevisionChange,
  onRevisionConflict,
  onOpenRevisionConflict,
}: UseVariantOperationsOptions): UseVariantOperationsReturn {
  const createMutation = useCreateProductVariant();
  const updateMutation = useUpdateProductVariant();
  const deleteMutation = useDeleteProductVariant();
  const bulkDeleteMutation = useBulkDeleteProductVariants();
  const bulkCreateMutation = useBulkCreateProductVariants();
  const editPlanMutation = useApplyProductVariantEditPlan();

  const isLoading =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    bulkDeleteMutation.isPending ||
    bulkCreateMutation.isPending ||
    editPlanMutation.isPending;

  const canMutate = () => {
    if (!revisionConflict) return true;
    onOpenRevisionConflict();
    return false;
  };

  const reportRevisionConflict = (error: unknown) => {
    const conflict = readProductRevisionConflict(error);
    if (!conflict) return false;
    onRevisionConflict(conflict);
    return true;
  };

  const createVariant = async (
    productId: string,
    values: VariantFormValues
  ): Promise<ProductVariant | null> => {
    if (!canMutate()) return null;
    try {
      const result = await createMutation.mutateAsync({
        productId,
        variant: values,
        expectedAggregateRevision: aggregateRevision,
      });
      onAggregateRevisionChange(result.aggregateRevision);
      return toProductVariant(result);
    } catch (error) {
      reportRevisionConflict(error);
      // Error toast is handled by the mutation's onError
      return null;
    }
  };

  const updateVariant = async (
    productId: string,
    variantId: string,
    values: VariantFormValues
  ): Promise<ProductVariant | null> => {
    if (!canMutate()) return null;
    try {
      const result = await updateMutation.mutateAsync({
        productId,
        variantId,
        variant: values,
        expectedAggregateRevision: aggregateRevision,
      });
      onAggregateRevisionChange(result.aggregateRevision);
      return toProductVariant(result);
    } catch (error) {
      reportRevisionConflict(error);
      return null;
    }
  };

  const deleteVariant = async (productId: string, variantId: string): Promise<boolean> => {
    if (!canMutate()) return false;
    try {
      const result = await deleteMutation.mutateAsync({
        productId,
        variantId,
        expectedAggregateRevision: aggregateRevision,
      });
      onAggregateRevisionChange(result.aggregateRevision);
      return true;
    } catch (error) {
      reportRevisionConflict(error);
      return false;
    }
  };

  const bulkDeleteVariants = async (
    productId: string,
    variantIds: string[]
  ): Promise<boolean> => {
    if (!canMutate()) return false;
    try {
      const result = await bulkDeleteMutation.mutateAsync({
        productId,
        variantIds,
        expectedAggregateRevision: aggregateRevision,
      });
      onAggregateRevisionChange(result.aggregateRevision);
      return true;
    } catch (error) {
      reportRevisionConflict(error);
      return false;
    }
  };

  const bulkCreateVariants = async (
    productId: string,
    variants: BulkGeneratedVariant[]
  ): Promise<ProductVariant[]> => {
    if (!canMutate()) {
      throw new Error("Review the product conflict before creating options.");
    }
    try {
      const result = await bulkCreateMutation.mutateAsync({
        productId,
        variants,
        expectedAggregateRevision: aggregateRevision,
      });
      onAggregateRevisionChange(result.aggregateRevision);
      const savedVariants = result.variants.map((variant) =>
        toProductVariant(variant),
      );
      return savedVariants;
    } catch (error) {
      if (reportRevisionConflict(error)) throw error;
      return [];
    }
  };

  const applyVariantEditPlan = async (
    productId: string,
    creates: BulkGeneratedVariant[],
    updates: VariantEditPlanUpdate[],
  ): Promise<{ created: ProductVariant[]; updated: ProductVariant[] } | null> => {
    if (!canMutate()) return null;
    try {
      const result = await editPlanMutation.mutateAsync({
        productId,
        plan: { creates, updates },
        expectedAggregateRevision: aggregateRevision,
      });
      onAggregateRevisionChange(result.aggregateRevision);
      return {
        created: result.created.map(toProductVariant),
        updated: result.updated.map(toProductVariant),
      };
    } catch (error) {
      if (reportRevisionConflict(error)) return null;
      throw error;
    }
  };

  return {
    createVariant,
    updateVariant,
    deleteVariant,
    bulkDeleteVariants,
    bulkCreateVariants,
    applyVariantEditPlan,
    isLoading,
  };
}
