// The theme editor's preview-only paint route: what an unsaved document
// paints (tokens, card and type attributes, font faces), so the editor's
// frame shows a colour, font or density edit without a reload. Checks and
// headers: lib/theme-preview-post.ts.
import type { APIRoute } from "astro";
import { storefrontPreviewPaintSchema } from "@scalius/shared/storefront-theme";
import { requestThemeFor, readStoreShape } from "@/lib/storefront-theme-context";
import { themePaint } from "@/lib/theme-paint";
import { THEME_PREVIEW_ROUTE_HEADERS, readThemePreviewPost } from "@/lib/theme-preview-post";

export const prerender = false;

export const ALL: APIRoute = async (context) => {
  const post = await readThemePreviewPost(context, storefrontPreviewPaintSchema);
  if (post instanceof Response) return post;
  const { theme } = post.body;
  const resolved = requestThemeFor(theme, readStoreShape(post.layoutData.storeShape)).resolved;
  const paint = themePaint(theme, resolved);
  return new Response(JSON.stringify({
    css: paint.css,
    attributes: { ...paint.attributes, ...paint.cardAttributes },
    fonts: paint.fonts.css,
  }), {
    status: 200,
    headers: { ...THEME_PREVIEW_ROUTE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
};
