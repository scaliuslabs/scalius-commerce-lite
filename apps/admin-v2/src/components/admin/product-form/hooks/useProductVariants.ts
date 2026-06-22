// src/components/admin/product-form/hooks/useProductVariants.ts
import { useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { extractUniqueVariantOptionValues } from "../utils";
import { productVariantsQueryOptions } from "@/lib/api-query-options/products";
import { queryKeys } from "@/lib/query-keys";
import type { ProductVariantDto } from "@/lib/api-functions/products";

interface UseProductVariantsOptions {
  productId?: string;
  isEdit: boolean;
}

interface UseProductVariantsReturn {
  variants: ProductVariantDto[];
  uniqueOptionOneValues: string[];
  uniqueOptionTwoValues: string[];
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

  const uniqueOptionOneValues = useMemo(() => {
    return extractUniqueVariantOptionValues(variants, "option1");
  }, [variants]);

  const uniqueOptionTwoValues = useMemo(() => {
    return extractUniqueVariantOptionValues(variants, "option2");
  }, [variants]);

  // Invalidate the variants query to trigger a refetch
  const refreshVariants = useCallback(() => {
    if (productId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.variants(productId) });
    }
  }, [queryClient, productId]);

  return {
    variants,
    uniqueOptionOneValues,
    uniqueOptionTwoValues,
    isLoading,
    refreshVariants,
  };
}
