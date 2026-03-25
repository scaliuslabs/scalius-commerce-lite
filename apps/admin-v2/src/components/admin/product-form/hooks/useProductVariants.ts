// src/components/admin/product-form/hooks/useProductVariants.ts
import { useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUniqueColors } from "../utils";
import { productVariantsQueryOptions } from "@/lib/api.queries";
import { queryKeys } from "@/lib/query-keys";

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
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    ...productVariantsQueryOptions(productId ?? ""),
    enabled: !!productId && isEdit,
  });

  // The API returns { variants: [...] } or a raw array — normalize to array
  const variants = useMemo(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (typeof data === "object" && "variants" in (data as Record<string, unknown>)) {
      const obj = data as Record<string, unknown>;
      return Array.isArray(obj.variants) ? obj.variants : [];
    }
    return [];
  }, [data]);

  // Extract unique colors from variants for image mapping
  const uniqueColorOptions = useMemo(() => {
    return extractUniqueColors(variants);
  }, [variants]);

  // Invalidate the variants query to trigger a refetch
  const refreshVariants = useCallback(() => {
    if (productId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.variants(productId) });
    }
  }, [queryClient, productId]);

  return {
    variants,
    uniqueColorOptions,
    isLoading,
    refreshVariants,
  };
}
