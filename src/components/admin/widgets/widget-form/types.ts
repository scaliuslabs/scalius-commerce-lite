
import type { Product, Category } from '@/db/schema';

export interface MediaFile {
  id: string;
  url: string;
  filename: string;
  size: number;
  createdAt: Date;
}

export type ProductSearchResult = Pick<Product, "id" | "name" | "slug"> & {
  primaryImage: string | null;
};

export type { Category };
