/**
 * The public product reads browser scripts make (a card's quick add, the
 * "Recently viewed" check), as plain `fetch` calls. They send the requests the
 * generated SDK sent through the transport (same URL, method and headers, the
 * same per-attempt timeout and retries) and read the answers through the same
 * normalizers as the server (`product-payloads.ts`), so a page that uses them
 * ships neither the SDK nor the transport.
 */
import type { PaginatedResponse, Product } from "./types";
import {
  normalizeProductListPayload,
  normalizeProductPageData,
  type ProductBySlugResult,
} from "./product-payloads";

/** Per attempt, as the transport's public reads. */
const READ_TIMEOUT_MS = 8_000;
/** Attempts after the first one failed without an answer (never after a timeout). */
const READ_RETRIES = 3;

class BrowserReadTimeoutError extends Error {
  constructor() {
    super(`Storefront API fetch timed out after ${READ_TIMEOUT_MS}ms`);
    this.name = "StorefrontFetchTimeoutError";
  }
}

/**
 * The API origin: the public paths below carry `/api/v1` themselves.
 * Layout.astro injects `__API_BASE_URL__` (`browser-url.ts`).
 */
function apiOrigin(): string {
  const base = window.__API_BASE_URL__;
  if (!base) {
    throw new Error(
      "PUBLIC_API_URL is not configured. Set the API URL in the dashboard under Settings -> System -> Platform.",
    );
  }
  return base.replace(/\/api\/v1\/?$/, "") || base;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = fetch(url, { method: "GET", headers: {}, signal: controller.signal });
  const timeout = new Promise<Response>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new BrowserReadTimeoutError();
      reject(error);
      controller.abort(error);
    }, READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    request.catch(() => undefined);
  }
}

/** A cookie-less GET, retried after a network failure (0, 300, 600 ms), never after a timeout. */
async function publicRead(url: string): Promise<Response> {
  for (let retries = READ_RETRIES; ; retries -= 1) {
    try {
      return await fetchWithTimeout(url);
    } catch (error: unknown) {
      if (retries > 0 && !(error instanceof BrowserReadTimeoutError)) {
        console.warn(`Fetch to ${url} failed. Retrying... (${retries} left)`);
        await new Promise((resolve) => setTimeout(resolve, 300 * (READ_RETRIES - retries)));
        continue;
      }
      console.error(`Fetch failed for ${url} after multiple retries.`, error);
      throw error;
    }
  }
}

interface ReadResult {
  data?: unknown;
  error?: unknown;
  response?: Response;
}

function isJsonContentType(contentType: string | null): boolean {
  const type = contentType?.split(";")[0]?.trim() ?? "";
  return type.startsWith("application/json") || type.endsWith("+json");
}

/**
 * The answer as the SDK client read it: a JSON body is data (an empty body
 * is `{}`); any other body is no data; a refused answer is its error body.
 */
async function readPublicJson(url: string): Promise<ReadResult> {
  let response: Response | undefined;
  try {
    response = await publicRead(url);
    if (response.ok) {
      if (!isJsonContentType(response.headers.get("Content-Type"))) return { data: null, response };
      if (response.status === 204 || response.headers.get("Content-Length") === "0") return { data: {}, response };
      const text = await response.text();
      return { data: text ? JSON.parse(text) : {}, response };
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON refusal is its text.
    }
    return { error: (body ?? text) || {}, response };
  } catch (error: unknown) {
    return { error: error || {}, response };
  }
}

/** `GET /api/v1/products?ids=…&limit=…`: the listed products that are still public, or null when the read failed. */
export async function fetchProductsByIds(
  ids: string,
  limit: number,
): Promise<PaginatedResponse<Product> | null> {
  try {
    const query = `ids=${encodeURIComponent(ids)}&limit=${encodeURIComponent(limit)}`;
    const { data, error } = await readPublicJson(`${apiOrigin()}/api/v1/products?${query}`);
    if (error) {
      console.error("Error fetching all products:", error);
      return null;
    }
    return normalizeProductListPayload(data);
  } catch (error: unknown) {
    console.error("Error fetching all products:", error);
    return null;
  }
}

/**
 * `GET /api/v1/products/{slug}`, keeping an authoritative 404 apart from a
 * temporary or malformed answer (as `getProductBySlugResult()` does).
 */
export async function fetchProductBySlugResult(slug: string): Promise<ProductBySlugResult> {
  if (!slug) {
    console.error("getProductBySlugResult: slug is required.");
    return { state: "unavailable" };
  }
  try {
    const { data, error, response } = await readPublicJson(
      `${apiOrigin()}/api/v1/products/${encodeURIComponent(slug)}`,
    );
    if (response?.status === 404) return { state: "not_found" };
    if (error || (response && (response.status < 200 || response.status >= 300))) {
      console.error(
        `Error fetching product by slug "${slug}" (status ${response?.status ?? "unknown"}).`,
      );
      return { state: "unavailable" };
    }
    const productData = normalizeProductPageData(data);
    if (!productData) {
      console.error(`Invalid product response for slug "${slug}".`);
      return { state: "unavailable" };
    }
    return { state: "found", data: productData };
  } catch (error: unknown) {
    console.error(`Error fetching product by slug "${slug}":`, error);
    return { state: "unavailable" };
  }
}
