import { listPaged } from "./api-read.mjs";

function unwrapConfig(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createApplyRuntime(readClient) {
  async function exactFromList(command, path, key, collectionKey) {
    const rows = await listPaged(readClient, { path, collectionKey, label: `Resolve ${command.logicalKey}` });
    const matches = rows.filter((row) => row[key] === command.identity[key]);
    if (matches.length > 1) throw new Error(`Exact identity is ambiguous for ${command.logicalKey}.`);
    return matches[0] ?? null;
  }
  return {
    async resolveCurrent(command) {
      if (command.phase === "categories") {
        if (command.identity.id) return readClient.get(`/api/v1/admin/categories/${encodeURIComponent(command.identity.id)}`, command.logicalKey);
        return exactFromList(command, "/api/v1/admin/categories", "slug", "categories");
      }
      if (command.phase === "products" || command.phase === "product-options" || command.phase === "product-stock-initialization") {
        if (command.identity.id) return readClient.get(`/api/v1/admin/products/${encodeURIComponent(command.identity.id)}`, command.logicalKey);
        const row = await exactFromList(command, "/api/v1/admin/products", "slug", "products");
        return row ? readClient.get(`/api/v1/admin/products/${encodeURIComponent(row.id)}`, command.logicalKey) : null;
      }
      if (command.phase === "collections") {
        if (command.identity.id) return readClient.get(`/api/v1/admin/collections/${encodeURIComponent(command.identity.id)}`, command.logicalKey);
        return exactFromList(command, "/api/v1/admin/collections", "name", "collections");
      }
      if (command.logicalKey === "settings:theme") return readClient.get("/api/v1/admin/settings/theme", command.logicalKey);
      if (command.logicalKey.startsWith("settings:hero:")) {
        const heroes = await readClient.get("/api/v1/admin/settings/hero-sliders", command.logicalKey);
        return heroes.find((hero) => hero.id === command.identity.id || hero.type === command.identity.type) ?? null;
      }
      throw new Error(`No resolver for ${command.logicalKey}.`);
    },
    async matchesDesired(command, current) {
      if (command.phase === "categories") return current.slug === command.body.slug && current.name === command.body.name && current.description === command.body.description;
      if (command.phase === "products") return current.slug === command.body.slug && current.name === command.body.name && current.price === command.body.price && current.description === command.body.description && current.categoryId === command.body.categoryId;
      if (command.phase === "product-options") {
        const desired = command.body.variants.map((variant) => variant.selectedOptionValueIds.join("|")).sort();
        const actual = (current.variants ?? []).map((variant) => variant.optionCombinationKey).filter(Boolean).sort();
        return equal(actual, desired);
      }
      if (command.phase === "product-stock-initialization") {
        const variant = current.variants?.find((item) => item.id === command.identity.variantId);
        return variant?.stock === command.desired.stock && variant.trackInventory === true;
      }
      if (command.phase === "collections") return current.name === command.body.name && current.presentation === command.body.presentation && equal(unwrapConfig(current.config), command.body.config);
      if (command.logicalKey === "settings:theme") return equal(current.colors, command.body.colors);
      if (command.logicalKey.startsWith("settings:hero:")) return current.type === (command.body.type ?? command.desired.type) && equal(current.images, command.body.images) && current.isActive === command.body.isActive;
      return false;
    },
  };
}

