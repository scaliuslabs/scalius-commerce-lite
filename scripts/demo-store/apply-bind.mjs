import { stableDraftId } from "./compile.mjs";

function exactMap(rows, key, label) {
  const map = new Map();
  for (const row of rows ?? []) {
    if (map.has(row[key])) throw new Error(`${label} identity is ambiguous: ${row[key]}`);
    map.set(row[key], row);
  }
  return map;
}

function productContext(manifest, snapshot) {
  return {
    manifestBySlug: exactMap(manifest.products, "slug", "Manifest product"),
    detailsBySlug: exactMap(snapshot.productDetails, "slug", "Product detail"),
    categoriesBySlug: exactMap(snapshot.categories, "slug", "Category"),
    collectionsByName: exactMap(snapshot.collections, "name", "Collection"),
  };
}

function currentVariant(product, detail, logicalKey) {
  if (!product) throw new Error(`Unknown manifest product for variant ${logicalKey}.`);
  const intended = product.variants.find((variant) => variant.logicalKey === logicalKey);
  if (!intended) throw new Error(`Unknown manifest variant ${logicalKey}.`);
  const matches = (detail?.variants ?? []).filter((variant) => {
    const values = (variant.selectedOptions ?? []).slice().sort((a, b) => a.position - b.position).map((item) => item.value);
    return JSON.stringify(values) === JSON.stringify(intended.optionValues);
  });
  if (matches.length > 1) throw new Error(`Current variant identity is ambiguous: ${logicalKey}.`);
  return { intended, match: matches[0] };
}

function fieldValue(value, field) {
  if (field === undefined || field === "id") return value?.id ?? value;
  if (!(field in (value ?? {}))) throw new Error(`Resolved authority does not contain ${field}.`);
  return value[field];
}

export function createApplyBinder({ manifest, readiness, snapshot, outputs = new Map() }) {
  const context = productContext(manifest, snapshot);
  const brands = (snapshot.attributes ?? []).filter((attribute) => attribute.slug === "brand");
  if (brands.length > 1) throw new Error("Brand attribute identity is ambiguous.");
  const brand = brands.find((attribute) => attribute.name === "Brand" && attribute.filterable === true);

  function resolveReference(reference) {
    const key = reference.$ref;
    if (outputs.has(key)) return fieldValue(outputs.get(key), reference.field);
    if (key === "attribute:brand") {
      if (!brand) throw new Error("The filterable Brand attribute must exist before product apply.");
      return fieldValue(brand, reference.field);
    }
    if (key.startsWith("media:")) {
      const logicalKey = key.slice("media:".length);
      const asset = readiness.assets.get(logicalKey);
      if (!asset) throw new Error(`Staged asset is missing for ${logicalKey}.`);
      if (reference.field === "categoryImage") return { id: asset.mediaId, url: asset.url, filename: asset.filename, size: asset.size, createdAt: asset.createdAt };
      if (reference.field === undefined || reference.field === "id" || reference.field === "mediaId") return asset.mediaId;
      return reference.field ? fieldValue(asset, reference.field) : asset.mediaId;
    }
    if (key.startsWith("category:")) {
      const category = context.categoriesBySlug.get(key.slice("category:".length));
      if (!category) throw new Error(`Category reference is unresolved: ${key}.`);
      return fieldValue(category, reference.field);
    }
    if (key.startsWith("current-product:")) {
      const slug = key.slice("current-product:".length);
      const detail = context.detailsBySlug.get(slug);
      const product = context.manifestBySlug.get(slug);
      if (!detail || !product) throw new Error(`Current product reference is unresolved: ${slug}.`);
      if (reference.field === "defaultVariantId") {
        const active = detail.variants.filter((variant) => !variant.deletedAt && variant.isDefault === true);
        if (active.length !== 1) throw new Error(`Simple product ${slug} does not have one default SKU.`);
        return active[0].id;
      }
      if (reference.field === "attributesWithBrand") {
        if (!brand) throw new Error("The filterable Brand attribute must exist before product apply.");
        return [...(detail.attributes ?? []).filter((item) => item.attributeId !== brand?.id), { attributeId: brand.id, value: product.brand }];
      }
      if (reference.field === "removedSkuImageIds") {
        const desiredMediaIds = new Set(product.media
          .filter((item) => item.role !== "poster")
          .map((item) => readiness.assets.get(item.logicalKey)?.mediaId)
          .filter(Boolean));
        const removedAssociationIds = new Set((detail.media ?? [])
          .filter((item) => !desiredMediaIds.has(item.mediaId))
          .map((item) => item.id));
        return [...new Set((detail.variants ?? [])
          .map((variant) => variant.imageId)
          .filter((imageId) => imageId && removedAssociationIds.has(imageId)))];
      }
      return fieldValue(detail, reference.field);
    }
    if (key.startsWith("bound-product-media:")) {
      const rest = key.slice("bound-product-media:".length);
      const separator = rest.indexOf(":");
      const slug = rest.slice(0, separator);
      const mediaLogicalKey = rest.slice(separator + 1);
      const detail = context.detailsBySlug.get(slug);
      const asset = readiness.assets.get(mediaLogicalKey);
      const existing = detail?.media?.find((item) => item.mediaId === asset?.mediaId);
      return existing?.id ?? stableDraftId("pmed_demo", `product:${slug}:${mediaLogicalKey}`);
    }
    if (key.startsWith("current-option-value:")) {
      const rest = key.slice("current-option-value:".length);
      const separator = rest.indexOf(":");
      const slug = rest.slice(0, separator);
      const optionAndValue = rest.slice(separator + 1);
      const product = context.manifestBySlug.get(slug);
      const axis = product?.options.find((candidate) => candidate.values.some((value) => `${candidate.name}:${value}` === optionAndValue));
      if (!axis) throw new Error(`Current option value reference is unresolved: ${key}.`);
      const value = optionAndValue.slice(axis.name.length + 1);
      if (!axis.values.includes(value)) throw new Error(`Current option value reference is unresolved: ${key}.`);
      const detail = context.detailsBySlug.get(slug);
      const found = detail?.options?.find((option) => option.name === axis.name)?.values?.find((item) => item.value === value);
      return found?.id ?? stableDraftId("draft_value", `product:${slug}:${axis.name}:${value}`);
    }
    if (key.startsWith("current-option:")) {
      const rest = key.slice("current-option:".length);
      const separator = rest.indexOf(":");
      const slug = rest.slice(0, separator);
      const axisName = rest.slice(separator + 1);
      const product = context.manifestBySlug.get(slug);
      if (!product?.options.some((option) => option.name === axisName)) throw new Error(`Current option reference is unresolved: ${key}.`);
      const detail = context.detailsBySlug.get(slug);
      const found = detail?.options?.find((option) => option.name === axisName);
      return found?.id ?? stableDraftId("draft_option", `product:${slug}:${axisName}`);
    }
    if (key.startsWith("current-variant:")) {
      const logicalKey = key.slice("current-variant:".length);
      const slug = logicalKey.slice(0, logicalKey.indexOf(":"));
      const product = context.manifestBySlug.get(slug);
      const detail = context.detailsBySlug.get(slug);
      const { intended, match } = currentVariant(product, detail, logicalKey);
      const fallback = {
        id: stableDraftId("draft_variant", intended.logicalKey), sku: intended.sku,
        stock: intended.inventory.mode === "tracked" ? intended.inventory.onHand : null,
        trackInventory: true, weight: null, barcode: null, barcodeType: null, imageId: null,
      };
      const authority = match ?? fallback;
      if (intended.inventory.mode === "preserve" && !match) throw new Error(`Retained variant is missing: ${logicalKey}.`);
      return fieldValue(authority, reference.field);
    }
    if (key.startsWith("current-section:")) {
      const logicalKey = key.slice("current-section:".length);
      const slug = logicalKey.slice(0, logicalKey.indexOf(":"));
      const intended = context.manifestBySlug.get(slug)?.additionalSections.find((section) => section.logicalKey === logicalKey);
      const existing = context.detailsBySlug.get(slug)?.additionalInfo?.find((section) => section.title === intended?.title);
      return existing?.id ?? stableDraftId("item-demo", logicalKey);
    }
    throw new Error(`Command reference is unresolved: ${key}.`);
  }

  function bindValue(value) {
    if (Array.isArray(value)) return value.map(bindValue);
    if (!value || typeof value !== "object") return value;
    if (typeof value.$ref === "string") return resolveReference(value);
    if (typeof value.$routeRef === "string") {
      const destination = value.$routeRef;
      if (destination.startsWith("category:")) return `/categories/${destination.slice("category:".length)}`;
      if (destination.startsWith("collection:")) {
        const name = manifest.collections.find((collection) => collection.logicalKey === destination)?.name;
        const collection = context.collectionsByName.get(name) ?? outputs.get(destination);
        if (!collection?.id) throw new Error(`Collection route is unresolved: ${destination}.`);
        return `/collections/${collection.id}`;
      }
      throw new Error(`Route reference is unresolved: ${destination}.`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindValue(item)]));
  }

  function executionMetadata(command, body) {
    if (command.logicalKey === "attribute:brand") {
      const current = brands[0];
      return {
        identity: { slug: "brand", ...(current?.id ? { id: current.id } : {}) },
        desired: { name: "Brand", slug: "brand", filterable: true },
      };
    }
    if (command.logicalKey.startsWith("category:")) {
      const slug = command.logicalKey.slice("category:".length).replace(/:publish$/u, "");
      const current = context.categoriesBySlug.get(slug);
      return { identity: { slug, ...(current?.id ? { id: current.id } : {}) }, desired: { slug } };
    }
    if (command.logicalKey.startsWith("product:")) {
      const product = manifest.products.find((item) => command.logicalKey.startsWith(`${item.logicalKey}:`));
      if (!product) throw new Error(`Product command identity is unresolved: ${command.logicalKey}.`);
      const current = context.detailsBySlug.get(product.slug);
      const base = outputs.get(`${product.logicalKey}:base`);
      const id = current?.id ?? base?.id;
      const variant = command.logicalKey.endsWith(":simple-sku") ? current?.variants?.find((item) => item.isDefault && !item.deletedAt) : null;
      return {
        identity: { slug: product.slug, ...(id ? { id } : {}), ...(variant?.id ? { variantId: variant.id } : {}) },
        desired: { slug: product.slug, ...(command.logicalKey.endsWith(":simple-sku") ? { stock: body.stock } : {}) },
      };
    }
    if (command.logicalKey.startsWith("collection:")) {
      const logicalKey = command.logicalKey.replace(/:(?:quarantine|activate)$/u, "");
      const collection = manifest.collections.find((item) => item.logicalKey === logicalKey);
      if (!collection) throw new Error(`Collection command identity is unresolved: ${command.logicalKey}.`);
      const current = context.collectionsByName.get(collection.name);
      return { identity: { name: collection.name, ...(current?.id ? { id: current.id } : {}) }, desired: { name: collection.name } };
    }
    if (command.logicalKey.startsWith("hero-slider:")) {
      const type = command.logicalKey
        .slice("hero-slider:".length)
        .replace(/:(?:quarantine|activate)$/u, "");
      const current = (snapshot.presentation?.heroes ?? snapshot.heroes ?? []).find((hero) => hero.type === type);
      return { identity: { type, ...(current?.id ? { id: current.id } : {}) }, desired: { type } };
    }
    throw new Error(`Execution metadata is unresolved: ${command.logicalKey}.`);
  }

  return {
    bind(command) {
      const pathBindings = bindValue(command.pathBindings ?? {});
      let path = command.path;
      for (const [name, value] of Object.entries(pathBindings)) path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
      if (/\{[^}]+\}/u.test(path)) throw new Error(`Command path remains unresolved: ${command.logicalKey}.`);
      const preconditions = bindValue(command.preconditions ?? {});
      const expectedRevision = preconditions.expectedRevision
        ?? preconditions.expectedAggregateRevision
        ?? preconditions.expectedVersion
        ?? command.expectedRevision;
      const body = bindValue(command.body);
      const metadata = executionMetadata(command, body);
      const bound = {
        ...command,
        path,
        body,
        preconditions,
        action: command.method === "POST" ? "create" : "update",
        expectedRevision,
        ...metadata,
      };
      delete bound.pathBindings;
      return bound;
    },
  };
}
