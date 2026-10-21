/**
 * The listing filter form posts; the gateway answers with a 303 to the GET
 * listing URL the form describes (post/redirect/get).
 *
 * A GET filter form is a crawl trap: crawlers enumerate its checkboxes, and
 * every subset of values is a distinct URL. In October 2026 one crawler sent
 * ~165,000 requests a day to a single category, every one a new combination
 * (`option.color` x `option.size` x availability x `showAll`), so every
 * request missed the page cache and paid a full render and an API batch: 95%
 * of the storefront's requests and 98% of its CPU. Crawlers follow links and
 * GET forms, never POST forms, so posting the form leaves them only the links
 * the page renders (the finite "See more" and applied-filter links).
 *
 * With JavaScript the form never submits natively (`setupCatalogFilters`
 * navigates to the same GET URL), so only a buyer without JavaScript takes
 * the extra redirect. The filtered pages themselves stay GET, cacheable and
 * shareable.
 */
import { logicalUrl } from "@/lib/market-presence";

/** Listing pages that render the filter form (`CatalogFilters`). */
const LISTING_PATH = /^\/(?:(?:categories|brands|collections)\/[^/]+|search)\/?$/;

/** A filter form is small (30 query entries of at most 512 characters, `getPublicStorefrontCachePolicy`). */
const MAX_FILTER_BODY_BYTES = 32 * 1024;

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** Whether a request is a native submission of a listing's filter form. */
export function isListingFilterSubmission(request: Request): boolean {
  if (request.method !== "POST") return false;
  const type = request.headers.get("Content-Type")?.split(";", 1)[0]!.trim().toLowerCase();
  if (type !== FORM_CONTENT_TYPE) return false;
  return LISTING_PATH.test(logicalUrl(new URL(request.url)).pathname);
}

/** The form's fields as listing URL params, without empty fields (the same rule as `catalogFilterSearchParams`). */
export function listingFilterSearchParams(body: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(body)) {
    const text = value.trim().replace(/\s+/g, " ");
    if (key && text) params.append(key, text);
  }
  return params;
}

async function readBoundedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FILTER_BODY_BYTES) return null;
  const body = await request.arrayBuffer();
  return body.byteLength > MAX_FILTER_BODY_BYTES ? null : new TextDecoder().decode(body);
}

/**
 * The 303 to the GET listing URL a filter form submission describes, on the
 * request's own path (its presence included); null when the request is not one.
 * An oversized body is refused (413), never rendered.
 */
export async function listingFilterRedirect(request: Request): Promise<Response | null> {
  if (!isListingFilterSubmission(request)) return null;
  const body = await readBoundedText(request);
  if (body === null) {
    return new Response("Payload Too Large", {
      status: 413,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  }
  const url = new URL(request.url);
  const query = listingFilterSearchParams(body).toString();
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${url.pathname}${query ? `?${query}` : ""}`,
      "Cache-Control": "private, no-store",
    },
  });
}
