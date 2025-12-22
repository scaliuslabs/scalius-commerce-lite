// src/components/admin/ProductForm/variants/hooks/useVariantOperations.ts

import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import type { ProductVariant, VariantFormValues, BulkGeneratedVariant } from "../types";

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
  duplicateVariant: (productId: string, variantId: string) => Promise<ProductVariant | null>;
  isLoading: boolean;
}

export function useVariantOperations(): UseVariantOperationsReturn {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);

  const createVariant = async (
    productId: string,
    values: VariantFormValues
  ): Promise<ProductVariant | null> => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/products/${productId}/variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to create variant");
      }

      const savedVariant: ProductVariant = {
        ...result,
        createdAt: new Date(result.createdAt),
        updatedAt: new Date(result.updatedAt),
        deletedAt: result.deletedAt ? new Date(result.deletedAt) : null,
      };

      toast({
        title: "Success!",
        description: "Variant has been created successfully.",
      });

      return savedVariant;
    } catch (error) {
      console.error("Failed to create variant:", error);
      toast({
        title: "Error Creating Variant",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
        variant: "destructive",
      });
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
      const response = await fetch(`/api/products/${productId}/variants/${variantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to update variant");
      }

      const savedVariant: ProductVariant = {
        ...result,
        createdAt: new Date(result.createdAt),
        updatedAt: new Date(result.updatedAt),
        deletedAt: result.deletedAt ? new Date(result.deletedAt) : null,
      };

      toast({
        title: "Success!",
        description: "Variant has been updated successfully.",
      });

      return savedVariant;
    } catch (error) {
      console.error("Failed to update variant:", error);
      toast({
        title: "Error Updating Variant",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
        variant: "destructive",
      });
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  const deleteVariant = async (productId: string, variantId: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/products/${productId}/variants/${variantId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Failed to delete variant");
      }

      toast({
        title: "Success!",
        description: "Variant has been deleted.",
      });

      return true;
    } catch (error) {
      console.error("Failed to delete variant:", error);
      toast({
        title: "Deletion Failed",
        description: error instanceof Error ? error.message : "Could not delete variant.",
        variant: "destructive",
      });
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
      const response = await fetch(`/api/products/${productId}/variants/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantIds }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Failed to delete variants");
      }

      toast({
        title: "Success!",
        description: `${variantIds.length} variants deleted.`,
      });

      return true;
    } catch (error) {
      console.error("Failed to bulk delete variants:", error);
      toast({
        title: "Bulk Deletion Failed",
        description: error instanceof Error ? error.message : "Could not delete variants.",
        variant: "destructive",
      });
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
      const response = await fetch(`/api/products/${productId}/variants/bulk-create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variants }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to create variants");
      }

      const savedVariants: ProductVariant[] = result.variants.map((v: any) => ({
        ...v,
        createdAt: new Date(v.createdAt),
        updatedAt: new Date(v.updatedAt),
        deletedAt: v.deletedAt ? new Date(v.deletedAt) : null,
      }));

      toast({
        title: "Success!",
        description: `${savedVariants.length} variants created successfully.`,
      });

      return savedVariants;
    } catch (error) {
      console.error("Failed to bulk create variants:", error);
      toast({
        title: "Bulk Creation Failed",
        description: error instanceof Error ? error.message : "Could not create variants.",
        variant: "destructive",
      });
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
      const response = await fetch(`/api/products/${productId}/variants/${variantId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to duplicate variant");
      }

      const savedVariant: ProductVariant = {
        ...result,
        createdAt: new Date(result.createdAt),
        updatedAt: new Date(result.updatedAt),
        deletedAt: result.deletedAt ? new Date(result.deletedAt) : null,
      };

      toast({
        title: "Success!",
        description: "Variant has been duplicated successfully.",
      });

      return savedVariant;
    } catch (error) {
      console.error("Failed to duplicate variant:", error);
      toast({
        title: "Duplication Failed",
        description: error instanceof Error ? error.message : "Could not duplicate variant.",
        variant: "destructive",
      });
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
    bulkCreateVariants,
    duplicateVariant,
    isLoading,
  };
}
