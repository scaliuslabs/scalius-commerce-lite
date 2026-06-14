import { createServerFn } from "@tanstack/react-start";
import { apiGet } from "../api.server";

export interface NavigationSource {
  id: string;
  name: string;
  slug: string;
  type: string;
  url: string;
}

export interface NavigationItemsPayload {
  items: {
    categories: NavigationSource[];
    pages: NavigationSource[];
  };
}

export type NavigationPreviewProductsInput = Record<string, string> & {
  categoryId: string;
};

export interface NavigationPreviewProductsPayload {
  count: number;
}

export const getNavigationItems = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<NavigationItemsPayload>("/navigation/items");
  },
);

export const getNavigationPreviewProducts = createServerFn({ method: "GET" })
  .validator((data: NavigationPreviewProductsInput) => data)
  .handler(async ({ data }) => {
    return apiGet<NavigationPreviewProductsPayload>(
      "/navigation/preview-products",
      data,
    );
  });
