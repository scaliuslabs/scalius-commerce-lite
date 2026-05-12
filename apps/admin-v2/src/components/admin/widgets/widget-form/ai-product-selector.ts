import type { ProductSearchResult } from "./types";

export interface RawProduct {
  id: string;
  name: string;
  slug: string;
  price?: number;
  isActive?: boolean;
  category?: { name: string };
  sku?: string;
  variantCount?: number;
  imageCount?: number;
  primaryImage: string | null;
}

export function toSelectableProducts(
  products: RawProduct[],
): ProductSearchResult[] {
  return products
    .filter((product) => product.isActive !== false)
    .map((product) => ({
      id: product.id,
      name: product.name,
      slug: product.slug,
      price: product.price,
      isActive: product.isActive,
      category: product.category,
      sku: product.sku,
      variantCount: product.variantCount,
      imageCount: product.imageCount,
      primaryImage: product.primaryImage,
    }));
}
