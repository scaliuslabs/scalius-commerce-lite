/**
 * The market and language selectors' target (Shopify's `/localization`): a
 * buyer's explicit choice. A plain form POST, so it works without
 * JavaScript. The country picks the market; `locale_code` (the language
 * form) picks that market's presence in the language, else the market's own
 * URL. It saves the country and the presence in the `localization` cookie
 * and answers 303 to the same page under that presence. The gateway then keeps later navigations there
 * (lib/market-presence.ts). Never cached; never a geo decision.
 */
import type { APIRoute } from "astro";
import {
  backupMarket,
  formatMarketSelection,
  marketOfCountry,
  normalizeMarketCountry,
  presencePath,
  primaryPresence,
} from "@scalius/shared/markets";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { getLayoutData } from "@/lib/api/storefront";
import { marketSelectionCookieHeader } from "@/lib/market-presence";
import { safeReturnPath } from "@/lib/market-selector";

export const prerender = false;

const MAX_FORM_BODY_BYTES = 4 * 1024;
const NO_STORE = "private, no-cache, no-store, must-revalidate";

function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": NO_STORE });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export const POST: APIRoute = async ({ request, url }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) return new Response("Forbidden", { status: 403 });
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_FORM_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return seeOther("/");
  }
  const returnTo = safeReturnPath(form.get("return_to"));
  const country = normalizeMarketCountry(form.get("country_code"));
  const matrix = (await getLayoutData())?.markets;
  if (!country || !matrix) return seeOther(returnTo);
  const market = marketOfCountry(matrix, country) ?? backupMarket(matrix);
  const locale = form.get("locale_code");
  const presence = market
    ? market.presences.find((each) => typeof locale === "string" && each.locale === locale) ?? primaryPresence(market)
    : null;
  if (!presence) return seeOther(returnTo);
  const cookie = marketSelectionCookieHeader(
    formatMarketSelection({ country, presence: presence.value }),
    url.protocol === "https:",
  );
  return seeOther(presencePath(presence.value, returnTo), cookie);
};

export const GET: APIRoute = () => new Response("Method Not Allowed", {
  status: 405,
  headers: { Allow: "POST", "Cache-Control": NO_STORE },
});
