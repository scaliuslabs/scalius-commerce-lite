// src/lib/api/navigation.ts

import { getConfiguredSdkClient } from "./transport";
import { unwrapData } from "./unwrap";
import { getApiV1NavigationCategories, getApiV1StorefrontRedirect } from "@scalius/api-client/sdk";
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



/**
 * Where an address that answered 404 leads (a URL redirect: a renamed
 * product's old handle), or null. Asked only on the not-found path, so pages
 * that exist never read it; a failed read is no redirect.
 */
export async function getUrlRedirect(path: string): Promise<string | null> {
  if (!path.startsWith("/") || path.length > 512) return null;
  try {
    const { data } = await getApiV1StorefrontRedirect({ client: getConfiguredSdkClient(), query: { path } });
    const toPath = unwrapData<{ toPath: string | null }>(data)?.toPath ?? null;
    // Only a path on this store: never another site.
    return toPath && toPath.startsWith("/") && !toPath.startsWith("//") ? toPath : null;
  } catch (error: unknown) {
    console.error("Error fetching a URL redirect:", error);
    return null;
  }
}
