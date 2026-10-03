/**
 * The geo hint (MARKETS-DESIGN D4): which market the buyer's location
 * (`cf-ipcountry`) suggests for a page, or none. Only a suggestion: the
 * banner asks, the buyer chooses. Private, never cached, and never asked by
 * a buyer who already chose a market.
 */
import type { APIRoute } from "astro";
import {
  readMarketSelectionCookie,
  resolveMarket,
  normalizeMarketCountry,
} from "@scalius/shared/markets";
import { getLayoutData } from "@/lib/api/storefront";

export const prerender = false;

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };

function regionName(code: string, language: string): string {
  try {
    return new Intl.DisplayNames([language, "en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const GET: APIRoute = async ({ request, url }) => {
  const none = new Response(JSON.stringify({ suggestion: null }), { headers: HEADERS });
  const geoCountry = normalizeMarketCountry(
    (request as Request & { cf?: { country?: string } }).cf?.country ?? request.headers.get("CF-IPCountry"),
  );
  const path = url.searchParams.get("path") ?? "/";
  const matrix = (await getLayoutData())?.markets;
  if (!geoCountry || !matrix || !path.startsWith("/") || path.length > 2_048) return none;
  const resolution = resolveMarket(matrix, {
    surface: "page",
    pathname: path,
    selection: readMarketSelectionCookie(request.headers.get("Cookie")),
    geoCountry,
    crawler: false,
    navigation: false,
  });
  if (!resolution.suggestion || !resolution.market) return none;
  const language = resolution.presence?.locale ?? "en";
  return new Response(JSON.stringify({
    suggestion: {
      market: { id: resolution.suggestion.market.id, name: resolution.suggestion.market.name },
      country: geoCountry,
      countryName: regionName(geoCountry, language),
    },
  }), { headers: HEADERS });
};
