const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_PAGES = 20;
const PAGE_LIMIT = 100;

function unwrap(body) {
  return body?.data ?? body;
}

async function parseJson(response, label) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`${label} response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`${label} response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} response was not valid JSON.`);
  }
}

export function createAdminReadClient({ adminOrigin, cookieHeader, fetchImpl = fetch, timeoutMs = 20_000 }) {
  async function get(path, label = path) {
    let response;
    try {
      response = await fetchImpl(`${adminOrigin}${path}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          "cache-control": "no-cache",
          cookie: cookieHeader,
          origin: adminOrigin,
        },
      });
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") throw new Error(`${label} timed out.`, { cause: error });
      throw new Error(`${label} failed before receiving a response.`, { cause: error });
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`${label} failed with HTTP ${response.status}.`);
    }
    return unwrap(await parseJson(response, label));
  }
  return { get };
}

export async function listPaged(client, {
  path, collectionKey, label, params = {}, maxPages = MAX_PAGES, limit = PAGE_LIMIT,
}) {
  const rows = [];
  let expectedTotal = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams({ ...params, page: String(page), limit: String(limit) });
    const body = await client.get(`${path}?${query}`, `${label} page ${page}`);
    const pageRows = body?.[collectionKey];
    const pagination = body?.pagination;
    if (!Array.isArray(pageRows) || !pagination || typeof pagination !== "object") {
      throw new Error(`${label} returned an invalid paged collection.`);
    }
    if (pageRows.length > limit) throw new Error(`${label} ignored the ${limit}-row page bound.`);
    const total = Number(pagination.total);
    const totalPages = Number(pagination.totalPages);
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(totalPages) || totalPages < 0) {
      throw new Error(`${label} returned invalid pagination totals.`);
    }
    expectedTotal ??= total;
    if (expectedTotal !== total) throw new Error(`${label} total changed while the snapshot was read.`);
    rows.push(...pageRows);
    if (page >= totalPages) {
      if (rows.length !== total) throw new Error(`${label} rows did not match the reported total.`);
      return rows;
    }
  }
  throw new Error(`${label} exceeded the ${maxPages}-page safety bound.`);
}

export async function listCursor(client, {
  path, collectionKey, label, params = {}, maxPages = MAX_PAGES, limit = PAGE_LIMIT,
}) {
  const rows = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams({ ...params, limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const body = await client.get(`${path}?${query}`, `${label} page ${page}`);
    const pageRows = body?.[collectionKey];
    const pagination = body?.pagination;
    if (!Array.isArray(pageRows) || !pagination || typeof pagination !== "object") {
      throw new Error(`${label} returned an invalid cursor collection.`);
    }
    if (pageRows.length > limit) throw new Error(`${label} ignored the ${limit}-row page bound.`);
    rows.push(...pageRows);
    if (!pagination.hasMore) return rows;
    const next = pagination.nextCursor;
    if (typeof next !== "string" || !next || next.length > 2_000 || seenCursors.has(next)) {
      throw new Error(`${label} returned an invalid or repeated cursor.`);
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error(`${label} exceeded the ${maxPages}-page safety bound.`);
}

function exactUniqueBySlug(rows, label) {
  const map = new Map();
  const duplicates = [];
  for (const row of rows) {
    if (typeof row?.slug !== "string" || !row.slug) throw new Error(`${label} returned a row without a slug.`);
    if (map.has(row.slug)) duplicates.push(row.slug);
    else map.set(row.slug, row);
  }
  if (duplicates.length) throw new Error(`${label} contains duplicate exact slugs: ${duplicates.join(", ")}`);
  return map;
}

export async function readAdminSnapshot(client, manifest) {
  const accountSecurity = await client.get("/api/v1/admin/auth/account-security", "Account security");
  if (!accountSecurity || typeof accountSecurity !== "object") throw new Error("Account security did not confirm an authenticated admin session.");

  const [categories, products, media, attributes, collections, general, theme, heroes] = await Promise.all([
    listPaged(client, { path: "/api/v1/admin/categories", collectionKey: "categories", label: "Categories", params: { sort: "createdAt", order: "asc" } }),
    listPaged(client, { path: "/api/v1/admin/products", collectionKey: "products", label: "Products", params: { sort: "createdAt", order: "asc" } }),
    listCursor(client, { path: "/api/v1/admin/media", collectionKey: "files", label: "Media", params: { view: "ready", sortBy: "createdAt", sortOrder: "asc" } }),
    listPaged(client, { path: "/api/v1/admin/attributes", collectionKey: "attributes", label: "Attributes", params: { sort: "createdAt", order: "asc" } }),
    listPaged(client, { path: "/api/v1/admin/collections", collectionKey: "collections", label: "Collections", params: { sort: "createdAt", order: "asc" } }),
    client.get("/api/v1/admin/settings/general", "General settings"),
    client.get("/api/v1/admin/settings/theme", "Theme settings"),
    client.get("/api/v1/admin/settings/hero-sliders", "Hero settings"),
  ]);

  const productBySlug = exactUniqueBySlug(products, "Products");
  const desiredProductSlugs = new Set(manifest.products.map((product) => product.slug));
  const matchedProducts = [...desiredProductSlugs]
    .map((slug) => productBySlug.get(slug))
    .filter(Boolean);
  const productDetails = [];
  for (const product of matchedProducts) {
    const detail = await client.get(`/api/v1/admin/products/${encodeURIComponent(product.id)}`, `Product detail ${product.slug}`);
    if (detail?.id !== product.id || detail?.slug !== product.slug) throw new Error(`Product detail identity changed for ${product.slug}.`);
    productDetails.push(detail);
  }

  return {
    capturedAt: new Date().toISOString(),
    auth: { authenticated: true, isSuperAdmin: accountSecurity.isSuperAdmin === true },
    categories,
    products,
    productDetails,
    media,
    attributes,
    collections,
    presentation: { general, theme, heroes },
  };
}
