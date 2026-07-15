import { listPaged } from "./api-read.mjs";

function unwrapConfig(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparableList(rows, fields) {
  return (rows ?? [])
    .map((row) => Object.fromEntries(fields.map((field) => [field, row?.[field] ?? null])))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function equalFields(current, desired, fields) {
  return fields.every((field) => (current?.[field] ?? null) === (desired?.[field] ?? null));
}

function comparableDiscount(value) {
  return {
    discountType: value?.discountType === "flat" ? "flat" : "percentage",
    discountPercentage: value?.discountPercentage ?? 0,
    discountAmount: value?.discountAmount ?? 0,
  };
}

function discountMatches(current, desired) {
  return equal(comparableDiscount(current), comparableDiscount(desired));
}

function productBaseMatches(command, current) {
  const scalarFields = [
    "slug", "name", "description", "price", "categoryId", "isActive",
    "freeDelivery", "metaTitle", "metaDescription",
    "canonicalPath", "noIndex", "excludeFromSitemap", "excludeFromProductFeed", "productCondition",
  ];
  if (!equalFields(current, command.body, scalarFields)) return false;
  if (!discountMatches(current, command.body)) return false;
  if (!equal(
    comparableList(current.media, ["id", "mediaId", "altText", "isPrimary"]),
    comparableList(command.body.media, ["id", "mediaId", "altText", "isPrimary"]),
  )) return false;
  if (!equal(
    comparableList(current.attributes, ["attributeId", "value"]),
    comparableList(command.body.attributes, ["attributeId", "value"]),
  )) return false;
  if (!equal(
    comparableList(current.additionalInfo, ["id", "title", "content", "sortOrder"]),
    comparableList(command.body.additionalInfo, ["id", "title", "content", "sortOrder"]),
  )) return false;
  return true;
}

function optionMatrixMatches(command, current) {
  const desiredOptions = comparableList(command.body.options, ["id", "name", "standardMapping"]);
  const actualOptions = comparableList(current.options, ["id", "name", "standardMapping"]);
  if (!equal(actualOptions, desiredOptions)) return false;
  for (const desired of command.body.options ?? []) {
    const actual = (current.options ?? []).find((option) => option.id === desired.id);
    if (!actual || !equal(
      comparableList(actual.values, ["id", "value"]),
      comparableList(desired.values, ["id", "value"]),
    )) return false;
  }
  const desiredVariants = (command.body.variants ?? []).map((variant) => ({
    id: variant.id,
    selectedOptionValueIds: [...variant.selectedOptionValueIds].sort(),
    imageId: variant.imageId ?? null,
    sku: variant.sku,
    price: variant.price,
    stock: variant.stock,
    trackInventory: variant.trackInventory,
    weight: variant.weight ?? null,
    barcode: variant.barcode ?? null,
    barcodeType: variant.barcodeType ?? null,
    ...comparableDiscount(variant),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const actualVariants = (current.variants ?? []).filter((variant) => !variant.deletedAt).map((variant) => ({
    id: variant.id,
    selectedOptionValueIds: (variant.selectedOptions ?? []).map((option) => option.optionValueId).sort(),
    imageId: variant.imageId ?? null,
    sku: variant.sku,
    price: variant.price,
    stock: variant.stock,
    trackInventory: variant.trackInventory,
    weight: variant.weight ?? null,
    barcode: variant.barcode ?? null,
    barcodeType: variant.barcodeType ?? null,
    ...comparableDiscount(variant),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return equal(actualVariants, desiredVariants);
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
      if (command.logicalKey === "attribute:brand") {
        return exactFromList(command, "/api/v1/admin/attributes", "slug", "attributes");
      }
      if (command.logicalKey.startsWith("category:")) {
        if (command.identity.id) return readClient.get(`/api/v1/admin/categories/${encodeURIComponent(command.identity.id)}`, command.logicalKey);
        return exactFromList(command, "/api/v1/admin/categories", "slug", "categories");
      }
      if (command.logicalKey.startsWith("product:")) {
        if (command.identity.id) return readClient.get(`/api/v1/admin/products/${encodeURIComponent(command.identity.id)}`, command.logicalKey);
        const row = await exactFromList(command, "/api/v1/admin/products", "slug", "products");
        return row ? readClient.get(`/api/v1/admin/products/${encodeURIComponent(row.id)}`, command.logicalKey) : null;
      }
      if (command.logicalKey.startsWith("collection:")) {
        if (command.identity.id) return readClient.get(`/api/v1/admin/collections/${encodeURIComponent(command.identity.id)}`, command.logicalKey);
        return exactFromList(command, "/api/v1/admin/collections", "name", "collections");
      }
      if (command.logicalKey.startsWith("hero-slider:")) {
        const heroes = await readClient.get("/api/v1/admin/settings/hero-sliders", command.logicalKey);
        return heroes.find((hero) => hero.id === command.identity.id || hero.type === command.identity.type) ?? null;
      }
      throw new Error(`No resolver for ${command.logicalKey}.`);
    },
    async matchesDesired(command, current) {
      if (command.logicalKey === "attribute:brand") {
        return current.slug === "brand" && current.name === "Brand" && current.filterable === true;
      }
      if (command.logicalKey.startsWith("category:")) {
        if (command.logicalKey.endsWith(":publish")) return current.status === command.body.status;
        const fields = [
          "slug", "name", "description", "metaTitle", "metaDescription", "canonicalPath",
          "noIndex", "excludeFromSitemap",
        ];
        return equalFields(current, command.body, fields)
          && (command.body.status === undefined || current.status === command.body.status)
          && (command.body.image === undefined || (current.imageUrl ?? null) === (command.body.image?.url ?? null));
      }
      if (command.logicalKey.endsWith(":matrix")) {
        return optionMatrixMatches(command, current);
      }
      if (command.logicalKey.endsWith(":simple-sku")) {
        const variant = current.variants?.find((item) => item.id === command.identity.variantId)
          ?? current.variants?.find((item) => item.isDefault === true && !item.deletedAt);
        return Boolean(variant)
          && equalFields(variant, command.body, [
            "imageId", "weight", "sku", "price", "stock", "trackInventory",
          ])
          && discountMatches(variant, command.body);
      }
      if (command.logicalKey.startsWith("product:")) return productBaseMatches(command, current);
      if (command.logicalKey.startsWith("collection:")) {
        if (command.body.name === undefined) return current.isActive === command.body.isActive;
        return equalFields(current, command.body, [
          "name", "presentation", "isActive", "canonicalPath", "noIndex", "excludeFromSitemap",
        ])
          && equal(unwrapConfig(current.config), command.body.config);
      }
      if (command.logicalKey.startsWith("hero-slider:")) {
        if (command.body.images === undefined) return current.isActive === command.body.isActive;
        return current.type === (command.body.type ?? command.desired.type)
          && equal(current.images, command.body.images)
          && current.isActive === command.body.isActive;
      }
      return false;
    },
  };
}
