// src/lib/api/navigation.ts

import { getConfiguredSdkClient } from "./transport";
import { unwrapData } from "./unwrap";
import { getApiV1NavigationCategories } from "@scalius/api-client/sdk";
import type { CategoryNavigationTree } from "./storefront";

/**
 * The whole reachable category tree (bounded, top levels first) for the
 * /categories index; the header gets a budget-sized cut with the layout.
 * The API caches it by cache generation; null on failure.
 */
export async function getCategoryNavigation(): Promise<CategoryNavigationTree | null> {
  try {
    const { data } = await getApiV1NavigationCategories({ client: getConfiguredSdkClient() });
    const tree = unwrapData<CategoryNavigationTree>(data);
    return tree && Array.isArray(tree.nodes) ? tree : null;
  } catch (error: unknown) {
    console.error("Error fetching the category tree:", error);
    return null;
  }
}


