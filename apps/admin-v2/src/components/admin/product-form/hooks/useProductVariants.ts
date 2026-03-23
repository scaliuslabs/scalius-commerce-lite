// src/components/admin/product-form/hooks/useProductVariants.ts
import { useState, useEffect, useMemo, useCallback } from "react";
import { extractUniqueColors } from "../utils";
import { getProductVariants } from "@/lib/api.functions";

interface UseProductVariantsOptions {
  productId?: string;
  isEdit: boolean;
}

interface UseProductVariantsReturn {
  variants: Array<{ color?: string | null; colorSortOrder?: number; [key: string]: unknown }>;
  uniqueColorOptions: string[];
  isLoading: boolean;
  refreshVariants: () => void;
}

export function useProductVariants({
  productId,
  isEdit,
}: UseProductVariantsOptions): UseProductVariantsReturn {
  const [variants, setVariants] = useState<Array<{ color?: string | null; colorSortOrder?: number; [key: string]: unknown }>>([]);
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
      const data = await getProductVariants({ data: { productId } }) as Record<string, unknown>;
      if (Array.isArray(data.variants)) {
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
