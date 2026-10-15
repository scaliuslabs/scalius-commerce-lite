import { media } from "@scalius/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { resolveMediaUrl } from "@scalius/shared/media-url";
import type { BuyerUiBlock, BuyerUiNode } from "@scalius/shared/plugins/buyer-ui";
import type { RegisteredPlugin } from "@scalius/core/modules/plugins";

/** Validate references against the app's approved declaration before exposing a tree. */
export async function prepareBuyerUiBlocks(db: Database, blocks: BuyerUiBlock[], registrations: readonly RegisteredPlugin[], mediaBase?: string): Promise<BuyerUiBlock[]> {
  const installations = new Map(registrations.map((item) => [item.installation.pluginId, item.installation]));
  const ids = new Set<string>();
  const valid = blocks.filter((block) => {
    const installation = installations.get(block.appId);
    if (!installation) return false;
    const fields = new Set(block.attributes.map((field) => field.key));
    const pending: BuyerUiNode[] = [block.ui];
    while (pending.length) {
      const node = pending.pop()!;
      if ("children" in node) pending.push(...node.children);
      if (node.type === "field" && !fields.has(node.attribute)) return false;
      if (node.type === "button") {
        const action = node.action;
        if (action.kind === "set_attribute" && !fields.has(action.key)) return false;
        if (action.kind === "app_route" && (!installation.manifest.storefront.proxy || !installation.manifest.routes.public.some((route) => route.name === action.route && route.methods.includes("POST")))) return false;
      }
      if (node.type === "image" && "media" in node.src) ids.add(node.src.media);
    }
    return true;
  });
  const urls: Record<string, string> = {};
  const allIds = [...ids];
  for (let offset = 0; offset < allIds.length; offset += 90) {
    const rows = await db.select({ id: media.id, objectKey: media.objectKey }).from(media)
      .where(and(inArray(media.id, allIds.slice(offset, offset + 90)), eq(media.status, "ready"), eq(media.kind, "image"))).all();
    for (const row of rows) {
      const url = resolveMediaUrl(row.objectKey, mediaBase);
      if (/^https?:\/\//.test(url)) urls[row.id] = url;
    }
  }
  return valid.map((block) => ({ ...block, ...(allIds.length ? { media: urls } : {}) }));
}
