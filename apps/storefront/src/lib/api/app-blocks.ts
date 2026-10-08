// Checkout and customer-account app blocks (`/storefront/app-blocks/<page>`):
// one cached batch part per page group, read only when the layout's
// `appBlockPages` names the page, so a store without such an app reads
// nothing more. A failure draws no block; the page never waits on an app.
import type { PluginBlockPage, PluginBlockTarget } from "@scalius/shared/plugins/storefront";
import { apiFetch, withEdgeCache } from "@/lib/api/transport";
import { readAppBlocks, type AppBlock } from "@/lib/app-surfaces";
import { unwrapData } from "./unwrap";

export async function getAppBlocks(page: PluginBlockPage): Promise<AppBlock[]> {
  const blocks = await withEdgeCache<AppBlock[]>(`app_blocks_${page}`, async () => {
    try {
      const response = await apiFetch(`/storefront/app-blocks/${page}`, { method: "GET" }, { retries: 0, timeout: 4_000, auth: false });
      if (!response.ok) {
        await response.body?.cancel();
        return [];
      }
      return readAppBlocks(unwrapData<{ blocks?: unknown }>(await response.json())?.blocks);
    } catch {
      return [];
    }
  });
  return blocks ?? [];
}

/** The blocks of one target, in order. */
export function blocksAt(blocks: readonly AppBlock[], target: PluginBlockTarget): AppBlock[] {
  return blocks.filter((block) => block.target === target);
}
