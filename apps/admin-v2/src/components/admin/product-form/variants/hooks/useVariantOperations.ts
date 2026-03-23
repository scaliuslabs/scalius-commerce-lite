// src/components/admin/ProductForm/variants/hooks/useVariantOperations.ts

import { useState } from "react";
import { toast } from "sonner";
import type { ProductVariant, VariantFormValues, BulkGeneratedVariant } from "../types";
import { getServerFnError } from "@/lib/api-helpers";
import {
  createProductVariant,
  updateProductVariant,
  deleteProductVariant,
  bulkDeleteProductVariants,
  bulkCreateProductVariants,
  bulkUpdateProductVariants,
  duplicateProductVariant,
} from "@/lib/api.functions";

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
  const [isLoading, setIsLoading] = useState(false);

  const createVariant = async (
    productId: string,
    values: VariantFormValues
  ): Promise<ProductVariant | null> => {
    setIsLoading(true);
    try {
      const result = await createProductVariant({
        data: { productId, variant: values as unknown as Record<string, unknown> },
      }) as Record<string, unknown>;
      const savedVariant: ProductVariant = {
        ...result,
        createdAt: new Date(result.createdAt as string),
        updatedAt: new Date(result.updatedAt as string),
        deletedAt: result.deletedAt ? new Date(result.deletedAt as string) : null,
      } as ProductVariant;

      toast.success("Success!", { description: "Variant has been created successfully." });

      return savedVariant;
    } catch (error: unknown) {
      console.error("Failed to create variant:", error);
      toast.error("Error Creating Variant", { description: getServerFnError(error, "An unknown error occurred.") });
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  const updateVariant = async (
    productId: string,
    variantId: string,
    values: VariantFormValues
  ): Promise<ProductVariant | null> => {
    setIsLoading(true);
    try {
      const result = await updateProductVariant({
        data: { productId, variantId, variant: values as unknown as Record<string, unknown> },
      }) as Record<string, unknown>;
      const savedVariant: ProductVariant = {
        ...result,
        createdAt: new Date(result.createdAt as string),
        updatedAt: new Date(result.updatedAt as string),
        deletedAt: result.deletedAt ? new Date(result.deletedAt as string) : null,
      } as ProductVariant;

      toast.success("Success!", { description: "Variant has been updated successfully." });

      return savedVariant;
    } catch (error: unknown) {
      console.error("Failed to update variant:", error);
      toast.error("Error Updating Variant", { description: getServerFnError(error, "An unknown error occurred.") });
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  const deleteVariant = async (productId: string, variantId: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      await deleteProductVariant({ data: { productId, variantId } });

      toast.success("Success!", { description: "Variant has been deleted." });

      return true;
    } catch (error: unknown) {
      console.error("Failed to delete variant:", error);
      toast.error("Deletion Failed", { description: getServerFnError(error, "Could not delete variant.") });
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const bulkDeleteVariants = async (
    productId: string,
    variantIds: string[]
  ): Promise<boolean> => {
    setIsLoading(true);
    try {
      await bulkDeleteProductVariants({ data: { productId, variantIds } });

      toast.success("Success!", { description: `${variantIds.length} variants deleted.` });

      return true;
    } catch (error: unknown) {
      console.error("Failed to bulk delete variants:", error);
      toast.error("Bulk Deletion Failed", { description: getServerFnError(error, "Could not delete variants.") });
      return false;
    } finally {
      setIsLoading(false);
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
    setIsLoading(true);
    try {
      await bulkUpdateProductVariants({
        data: { productId, updates: updates as Record<string, unknown>[] },
      });

      toast.success("Success!", { description: "Variants updated successfully." });

      return true;
    } catch (error: unknown) {
      console.error("Failed to bulk update variants:", error);
      toast.error("Update Failed", { description: getServerFnError(error, "Could not update variants.") });
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const bulkCreateVariants = async (
    productId: string,
    variants: BulkGeneratedVariant[]
  ): Promise<ProductVariant[]> => {
    setIsLoading(true);
    try {
      const result = await bulkCreateProductVariants({
        data: { productId, variants: variants as unknown as Record<string, unknown>[] },
      }) as Record<string, unknown>;
      const savedVariants: ProductVariant[] = (result.variants as Record<string, unknown>[]).map((v) => ({
        ...v,
        createdAt: new Date(v.createdAt as string),
        updatedAt: new Date(v.updatedAt as string),
        deletedAt: v.deletedAt ? new Date(v.deletedAt as string) : null,
      })) as ProductVariant[];

      toast.success("Success!", { description: `${savedVariants.length} variants created successfully.` });

      return savedVariants;
    } catch (error: unknown) {
      console.error("Failed to bulk create variants:", error);
      toast.error("Bulk Creation Failed", { description: getServerFnError(error, "Could not create variants.") });
      return [];
    } finally {
      setIsLoading(false);
    }
  };

  const duplicateVariant = async (
    productId: string,
    variantId: string
  ): Promise<ProductVariant | null> => {
    setIsLoading(true);
    try {
      const result = await duplicateProductVariant({
        data: { productId, variantId },
      }) as Record<string, unknown>;
      const savedVariant: ProductVariant = {
        ...result,
        createdAt: new Date(result.createdAt as string),
        updatedAt: new Date(result.updatedAt as string),
        deletedAt: result.deletedAt ? new Date(result.deletedAt as string) : null,
      } as ProductVariant;

      toast.success("Success!", { description: "Variant has been duplicated successfully." });

      return savedVariant;
    } catch (error: unknown) {
      console.error("Failed to duplicate variant:", error);
      toast.error("Duplication Failed", { description: getServerFnError(error, "Could not duplicate variant.") });
      return null;
    } finally {
      setIsLoading(false);
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
