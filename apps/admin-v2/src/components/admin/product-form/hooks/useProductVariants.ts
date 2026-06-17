// src/components/admin/product-form/hooks/useProductVariants.ts
import { useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUniqueColors } from "../utils";
import { productVariantsQueryOptions } from "@/lib/api-query-options/products";
import { queryKeys } from "@/lib/query-keys";
import type { ProductVariantDto } from "@/lib/api-functions/products";

interface UseProductVariantsOptions {
  productId?: string;
  isEdit: boolean;
}

interface UseProductVariantsReturn {
  variants: ProductVariantDto[];
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

  const variants = useMemo(() => {
    return data?.variants ?? [];
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
