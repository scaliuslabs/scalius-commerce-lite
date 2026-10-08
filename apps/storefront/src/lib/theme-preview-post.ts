/**
 * The checks every preview-only route of the theme editor makes before it
 * draws anything (`/theme-preview/render`, `/theme-preview/paint`): a POST
 * from the page itself (same origin), JSON within the size limit, a live
 * preview cookie (a staff preview session the API still knows) and a body
 * the theme's own schema accepts. Their answers are private and never
 * stored: the paths are private (`cache-policy.ts`) and every answer says
 * no-store.
 */
import { THEME_PREVIEW_BODY_MAX } from "@scalius/shared/theme-editor-bridge";
import { getLayoutData, type LayoutData } from "@/lib/api";
import { renderForPresence } from "@/lib/api/runtime";
import { isMarketSubfolder } from "@scalius/shared/markets";
import { isTrustedBrowserContinuationPostOrigin } from "@/lib/browser-continuation-relay";
import { resolveRequestTheme, type RequestTheme } from "@/lib/storefront-theme-context";
import { appendClearThemePreviewCookies, readThemePreviewCookie } from "@/lib/theme-preview-cookie";

export const THEME_PREVIEW_ROUTE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

export function themePreviewRefusal(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...THEME_PREVIEW_ROUTE_HEADERS, ...extra } });
}

export interface ThemePreviewPost<Body> {
  body: Body;
  token: string;
  layoutData: LayoutData;
  requestTheme: RequestTheme;
}

/** The validated post, or the response that refuses it. */
export async function readThemePreviewPost<Body>(
  astro: { request: Request; locals: object },
  schema: { safeParse(value: unknown): { success: true; data: Body } | { success: false } },
): Promise<ThemePreviewPost<Body> | Response> {
  const { request } = astro;
  if (request.method !== "POST") return themePreviewRefusal(405, { Allow: "POST" });
  if (!isTrustedBrowserContinuationPostOrigin(request)) return themePreviewRefusal(403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return themePreviewRefusal(415);
  const token = readThemePreviewCookie(request.headers.get("cookie"));
  if (!token) return themePreviewRefusal(401);
  const text = await request.text();
  if (text.length > THEME_PREVIEW_BODY_MAX) return themePreviewRefusal(413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return themePreviewRefusal(400);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) return themePreviewRefusal(400);
  // The market the editor previews (its currency, prices and language).
  const presence = (result.data as { presence?: unknown }).presence;
  if (typeof presence === "string" && isMarketSubfolder(presence)) renderForPresence(presence);
  const layoutData = await getLayoutData();
  if (!layoutData) return themePreviewRefusal(503);
  const requestTheme = await resolveRequestTheme(astro, layoutData);
  // An expired or revoked session: the bridge asks the editor for a new one.
  if (!requestTheme.preview) {
    const refusal = themePreviewRefusal(401);
    appendClearThemePreviewCookies(refusal.headers);
    return refusal;
  }
  return { body: result.data, token, layoutData, requestTheme };
}
