import { createServerFn } from "@tanstack/react-start";
import { apiGetText, apiPost } from "../api.server";

export interface AiPromptInput {
  type: string;
}

export interface AiContextBatchDetailsInput {
  productIds?: string[];
  categoryIds?: string[];
  collectionIds?: string[];
  anchorCollectionIds?: string[];
  allCategories?: boolean;
}

export interface AiProductContextDetail {
  id: string;
  name: string;
  description: string | null;
  price: number;
  discountType: "percentage" | "flat" | null;
  discountAmount: number | null;
  discountPercentage: number | null;
  freeDelivery: boolean;
  slug: string;
  url: string;
  buyNowUrl: string;
  finalPrice: number;
  category: {
    id: string;
    name: string;
    slug: string;
    url: string;
  } | null;
  images: Array<{ url: string; alt: string | null; isPrimary: boolean }>;
  variants: Array<{
    id: string;
    sku: string;
    size: string | null;
    color: string | null;
    stock: number;
    price: number;
    discountType: "percentage" | "flat" | null;
    discountAmount: number | null;
    discountPercentage: number | null;
    buyNowUrl: string;
    finalPrice: number;
  }>;
  attributes: Array<{ name: string; value: string }>;
}

export interface AiCategoryContextDetail {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  imageUrl: string | null;
  url: string;
}

export interface AiCollectionProductContextDetail {
  id: string;
  name: string;
  slug: string;
  url: string;
  price: number;
  discountedPrice: number;
  imageUrl: string | null;
  imageAlt: string | null;
}

export interface AiCollectionCategoryContextDetail {
  id: string;
  name: string;
  slug: string;
  url: string;
}

export interface AiCollectionContextDetail {
  id: string;
  name: string;
  type: "manual" | "dynamic";
  url: string;
  title: string | null;
  subtitle: string | null;
  placementRoles: Array<"target" | "anchor">;
  products: AiCollectionProductContextDetail[];
  categories: AiCollectionCategoryContextDetail[];
  featuredProduct: AiCollectionProductContextDetail | null;
}

export interface AiContextBatchWarnings {
  productsTruncated: boolean;
  categoriesTruncated: boolean;
  collectionsTruncated: boolean;
  productsUnavailable: number;
  categoriesUnavailable: number;
  collectionsUnavailable: number;
  maxProducts: number;
  maxCategories: number;
  maxCollections: number;
}

export interface AiContextBatchDetails {
  products: AiProductContextDetail[];
  categories: AiCategoryContextDetail[];
  collections: AiCollectionContextDetail[];
  warnings: AiContextBatchWarnings;
}

export const getAiPrompts = createServerFn({ method: "GET" })
  .validator((data: AiPromptInput) => data)
  .handler(async ({ data }) => {
    return apiGetText("/ai-prompts", { type: data.type });
  });

export const getAiContextBatchDetails = createServerFn({ method: "POST" })
  .validator((data: AiContextBatchDetailsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<AiContextBatchDetails>("/ai-context/batch-details", data);
  });
