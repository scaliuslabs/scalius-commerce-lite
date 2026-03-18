// src/components/admin/ProductForm/variants/hooks/useVariantOperations.ts

import { useState } from "react";
import { toast } from "sonner";
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
      const response = await fetch(`/api/v1/admin/products/${productId}/variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error || "Failed to create variant");
      }

      const result = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
      const savedVariant: ProductVariant = {
        ...result,
        createdAt: new Date(result.createdAt),
        updatedAt: new Date(result.updatedAt),
        deletedAt: result.deletedAt ? new Date(result.deletedAt) : null,
      };

      toast.success("Success!", { description: "Variant has been created successfully." });

      return savedVariant;
    } catch (error: unknown) {
      console.error("Failed to create variant:", error);
      toast.error("Error Creating Variant", { description: error instanceof Error ? error.message : "An unknown error occurred." });
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
      const response = await fetch(`/api/v1/admin/products/${productId}/variants/${variantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error || "Failed to update variant");
      }

      const result = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
      const savedVariant: ProductVariant = {
        ...result,
        createdAt: new Date(result.createdAt),
        updatedAt: new Date(result.updatedAt),
        deletedAt: result.deletedAt ? new Date(result.deletedAt) : null,
      };

      toast.success("Success!", { description: "Variant has been updated successfully." });

      return savedVariant;
    } catch (error: unknown) {
      console.error("Failed to update variant:", error);
      toast.error("Error Updating Variant", { description: error instanceof Error ? error.message : "An unknown error occurred." });
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  const deleteVariant = async (productId: string, variantId: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/admin/products/${productId}/variants/${variantId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Failed to delete variant");
      }

      toast.success("Success!", { description: "Variant has been deleted." });

      return true;
    } catch (error: unknown) {
      console.error("Failed to delete variant:", error);
      toast.error("Deletion Failed", { description: error instanceof Error ? error.message : "Could not delete variant." });
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
      const response = await fetch(`/api/v1/admin/products/${productId}/variants/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantIds }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Failed to delete variants");
      }

      toast.success("Success!", { description: `${variantIds.length} variants deleted.` });

      return true;
    } catch (error: unknown) {
      console.error("Failed to bulk delete variants:", error);
      toast.error("Bulk Deletion Failed", { description: error instanceof Error ? error.message : "Could not delete variants." });
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
      const response = await fetch(`/api/v1/admin/products/${productId}/variants/bulk-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Failed to update variants");
      }

      toast.success("Success!", { description: "Variants updated successfully." });

      return true;
    } catch (error: unknown) {
      console.error("Failed to bulk update variants:", error);
      toast.error("Update Failed", { description: error instanceof Error ? error.message : "Could not update variants." });
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
      const response = await fetch(`/api/v1/admin/products/${productId}/variants/bulk-create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variants }),
      });

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error || "Failed to create variants");
      }

      const result = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
      const savedVariants: ProductVariant[] = result.variants.map((v: Record<string, unknown>) => ({
        ...v,
        createdAt: new Date(v.createdAt as string),
        updatedAt: new Date(v.updatedAt as string),
        deletedAt: v.deletedAt ? new Date(v.deletedAt as string) : null,
      }));

      toast.success("Success!", { description: `${savedVariants.length} variants created successfully.` });

      return savedVariants;
    } catch (error: unknown) {
      console.error("Failed to bulk create variants:", error);
      toast.error("Bulk Creation Failed", { description: error instanceof Error ? error.message : "Could not create variants." });
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
      const response = await fetch(`/api/v1/admin/products/${productId}/variants/${variantId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error || "Failed to duplicate variant");
      }

      const result = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
      const savedVariant: ProductVariant = {
        ...result,
        createdAt: new Date(result.createdAt),
        updatedAt: new Date(result.updatedAt),
        deletedAt: result.deletedAt ? new Date(result.deletedAt) : null,
      };

      toast.success("Success!", { description: "Variant has been duplicated successfully." });

      return savedVariant;
    } catch (error: unknown) {
      console.error("Failed to duplicate variant:", error);
      toast.error("Duplication Failed", { description: error instanceof Error ? error.message : "Could not duplicate variant." });
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
