// A buyer's own page (cart, checkout, receipt, account, ...) is only ever a
// document: the browser navigates to it. A script that `fetch()`es it, or a page
// that embeds it, is reading what an approved app could read with the buyer's
// cookies (apps are trusted same-origin code), so those requests are refused.
// Browsers forbid page script from setting `Sec-Fetch-Dest`, so a fetch from an
// app arrives as "empty". A request without the header (an old browser, curl, a
// crawler) stays allowed: this narrows the surface, it is not authentication.
// The buyer's JSON endpoints under `/api` are not pages and stay callable by
// same-origin scripts; keeping apps off them would need a separate origin.
import { storefrontAppPage } from "@/lib/app-scripts";
import { PRIVATE_NO_STORE_CACHE_CONTROL } from "@/lib/cache-policy";

/** Whether this request fetches a buyer's own page as something other than a document. */
export function refusesBuyerPageFetch(request: Request, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const destination = request.headers.get("Sec-Fetch-Dest")?.trim().toLowerCase();
  if (!destination || destination === "document") return false;
  return storefrontAppPage(pathname) === "private";
}

export function buyerPageFetchRefusal(): Response {
  return new Response(null, {
    status: 403,
    headers: { "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL, Vary: "Sec-Fetch-Dest" },
  });
}
