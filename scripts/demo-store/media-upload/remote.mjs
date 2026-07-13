import { createHash } from "node:crypto";

import { listCursor, listPaged } from "../api-read.mjs";

function exactBy(rows, field, label) {
  const map = new Map();
  for (const row of rows ?? []) {
    if (!row?.[field] || map.has(row[field])) throw new Error(`${label} has a missing or duplicate ${field}.`);
    map.set(row[field], row);
  }
  return map;
}

export async function readFreshMediaState(readClient, manifest) {
  const security = await readClient.get("/api/v1/admin/auth/account-security", "Account security");
  if (!security || typeof security !== "object") throw new Error("Authenticated Media read was not confirmed.");
  const media = await listCursor(readClient, {
    path: "/api/v1/admin/media",
    collectionKey: "files",
    label: "Ready Media",
    params: { view: "ready", sortBy: "createdAt", sortOrder: "asc" },
  });
  const products = await listPaged(readClient, {
    path: "/api/v1/admin/products",
    collectionKey: "products",
    label: "Products for retained Media",
    params: { sort: "createdAt", order: "asc" },
  });
  const productBySlug = exactBy(products, "slug", "Product list");
  const retainedDetails = [];
  for (const product of manifest.products.filter((item) => item.retainedProductId)) {
    const row = productBySlug.get(product.slug);
    if (!row || row.id !== product.retainedProductId) throw new Error(`Retained product identity is missing or changed for ${product.slug}.`);
    const detail = await readClient.get(`/api/v1/admin/products/${encodeURIComponent(row.id)}`, `Retained product ${product.slug}`);
    if (detail?.id !== row.id || detail?.slug !== product.slug) throw new Error(`Retained product detail changed for ${product.slug}.`);
    retainedDetails.push(detail);
  }
  return { capturedAt: new Date().toISOString(), media, retainedDetails };
}

export async function hashRemoteMedia(file, expectedBytes, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  let url;
  try { url = new URL(file.url); } catch { throw new Error("Remote Media URL is invalid."); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("Remote Media URL must use HTTPS.");
  const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`Remote Media verification failed with HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared !== expectedBytes) {
    await response.body.cancel();
    throw new Error("Remote Media byte size does not match provenance.");
  }
  const digest = createHash("sha256");
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > expectedBytes) {
      await reader.cancel();
      throw new Error("Remote Media exceeded its expected byte size.");
    }
    digest.update(value);
  }
  if (received !== expectedBytes) throw new Error("Remote Media byte size does not match provenance.");
  return digest.digest("hex");
}
