// src/components/admin/product-form/hooks/useProductVariants.ts
import { useState, useEffect, useMemo, useCallback } from "react";
import { extractUniqueColors } from "../utils";

interface UseProductVariantsOptions {
  productId?: string;
  isEdit: boolean;
}

interface UseProductVariantsReturn {
  variants: any[];
  uniqueColorOptions: string[];
  isLoading: boolean;
  refreshVariants: () => void;
}

export function useProductVariants({
  productId,
  isEdit,
}: UseProductVariantsOptions): UseProductVariantsReturn {
  const [variants, setVariants] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Extract unique colors from variants for image mapping
  const uniqueColorOptions = useMemo(() => {
    return extractUniqueColors(variants);
  }, [variants]);

  // Fetch variants function
  const fetchVariants = useCallback(async () => {
    if (!isEdit || !productId) return;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/admin/products/${productId}/variants`);
      const json = await response.json();
      const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
      if (response.ok && Array.isArray(data.variants)) {
        setVariants(data.variants);
      }
    } catch (error: unknown) {
      console.error("Failed to fetch variants:", error);
    } finally {
      setIsLoading(false);
    }
  }, [isEdit, productId]);

  // Fetch variants if in edit mode
  useEffect(() => {
    fetchVariants();
  }, [fetchVariants]);

  return {
    variants,
    uniqueColorOptions,
    isLoading,
    refreshVariants: fetchVariants,
  };
}
