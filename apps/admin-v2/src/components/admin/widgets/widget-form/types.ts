
import type { Product, Category } from '@/types/api-responses';
import type { MediaFile } from "@/components/admin/media-manager/types";

export type { MediaFile };

export type ProductSearchResult = Pick<Product, "id" | "name" | "slug"> & {
  price?: number;
  isActive?: boolean;
  category?: { name: string };
  sku?: string;
  variantCount?: number;
  imageCount?: number;
  primaryImage: string | null;
};

export type { Category };
