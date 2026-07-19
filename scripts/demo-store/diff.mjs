function normalized(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function exactIndex(rows, key, label) {
  const index = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    const value = row?.[key];
    if (typeof value !== "string" || !value) throw new Error(`${label} row is missing ${key}.`);
    if (index.has(value)) duplicates.add(value);
    else index.set(value, row);
  }
  return { index, duplicates: [...duplicates] };
}

function changedFields(desired, actual, fields) {
  return fields.filter(([desiredKey, actualKey = desiredKey]) => desired[desiredKey] !== actual?.[actualKey]).map(([field]) => field);
}

function actualCombinationKeys(detail) {
  return (detail?.variants ?? []).map((variant) => (variant.selectedOptions ?? [])
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((item) => normalized(item.value))
    .join("\u001f"))
    .sort();
}

function desiredCombinationKeys(product) {
  return product.variants.map((variant) => variant.optionValues.map(normalized).join("\u001f")).sort();
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function configRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function summarize(resources) {
  return resources.reduce((counts, resource) => {
    counts[resource.action] = (counts[resource.action] ?? 0) + 1;
    return counts;
  }, { create: 0, update: 0, match: 0, conflict: 0 });
}

export function buildDemoStoreDiff(manifest, snapshot) {
  const categories = exactIndex(snapshot.categories, "slug", "Categories");
  const products = exactIndex(snapshot.products, "slug", "Products");
  const details = exactIndex(snapshot.productDetails, "slug", "Product details");
  const collectionNames = exactIndex(snapshot.collections, "name", "Collections");
  const attributes = exactIndex(snapshot.attributes, "slug", "Attributes");
  const categoryResources = [];
  const desiredCategoryIds = new Map();

  for (const desired of manifest.categories) {
    const actual = categories.index.get(desired.slug);
    if (!actual) {
      categoryResources.push({ logicalKey: desired.logicalKey, slug: desired.slug, resourceId: null, action: "create", fields: [] });
      continue;
    }
    desiredCategoryIds.set(desired.slug, actual.id);
    const fields = changedFields(desired, actual, [["name"], ["description"], ["status"]]);
    categoryResources.push({
      logicalKey: desired.logicalKey,
      slug: desired.slug,
      resourceId: actual.id,
      revision: actual.revision,
      action: fields.length ? "update" : "match",
      fields,
    });
  }

  const productResources = [];
  for (const desired of manifest.products) {
    const listItem = products.index.get(desired.slug);
    if (!listItem) {
      productResources.push({ logicalKey: desired.logicalKey, slug: desired.slug, resourceId: null, action: "create", fields: [] });
      continue;
    }
    if (desired.retainedProductId && listItem.id !== desired.retainedProductId) {
      productResources.push({
        logicalKey: desired.logicalKey,
        slug: desired.slug,
        resourceId: listItem.id,
        action: "conflict",
        fields: ["retainedProductId"],
      });
      continue;
    }
    const detail = details.index.get(desired.slug);
    if (!detail || detail.id !== listItem.id) {
      productResources.push({ logicalKey: desired.logicalKey, slug: desired.slug, resourceId: listItem.id, action: "conflict", fields: ["detailIdentity"] });
      continue;
    }
    const fields = changedFields(desired, detail, [
      ["name"], ["price"], ["descriptionHtml", "description"], ["freeDelivery"], ["condition", "productCondition"],
    ]);
    if (detail.isActive !== true) fields.push("isActive");
    const categoryId = desiredCategoryIds.get(desired.categorySlug);
    if (!categoryId || detail.categoryId !== categoryId) fields.push("categoryId");
    if (!sameStrings(actualCombinationKeys(detail), desiredCombinationKeys(desired))) fields.push("optionTopology");
    if ((detail.media ?? []).filter((media) => media.status === "ready").length !== desired.media.filter((media) => media.role !== "poster").length) fields.push("media");
    if ((detail.additionalInfo ?? []).length !== desired.additionalSections.length) fields.push("additionalSections");
    productResources.push({
      logicalKey: desired.logicalKey,
      slug: desired.slug,
      resourceId: listItem.id,
      aggregateRevision: detail.aggregateRevision,
      action: fields.length ? "update" : "match",
      fields: [...new Set(fields)],
    });
  }

  const collectionResources = manifest.collections.map((desired) => {
    const actual = collectionNames.index.get(desired.name);
    if (!actual) return { logicalKey: desired.logicalKey, name: desired.name, resourceId: null, action: "create", fields: [] };
    const fields = [];
    if (actual.presentation !== desired.presentation) fields.push("presentation");
    if (actual.isActive !== true) fields.push("isActive");
    if (configRecord(actual.config).showOnHomepage !== desired.showOnHomepage) fields.push("showOnHomepage");
    return { logicalKey: desired.logicalKey, name: desired.name, resourceId: actual.id, version: actual.version, action: fields.length ? "update" : "match", fields };
  });

  const brand = attributes.index.get("brand");
  const attributeResources = [{
    logicalKey: "attribute:brand",
    slug: "brand",
    resourceId: brand?.id ?? null,
    action: !brand ? "create" : brand.name === "Brand" && brand.filterable === true ? "match" : "conflict",
    fields: !brand ? [] : [brand.name !== "Brand" ? "name" : null, brand.filterable !== true ? "filterable" : null].filter(Boolean),
  }];

  const unexpected = {
    categorySlugs: snapshot.categories.filter((item) => !manifest.categories.some((desired) => desired.slug === item.slug)).map((item) => item.slug),
    productSlugs: snapshot.products.filter((item) => !manifest.products.some((desired) => desired.slug === item.slug)).map((item) => item.slug),
    collectionNames: snapshot.collections.filter((item) => !manifest.collections.some((desired) => desired.name === item.name)).map((item) => item.name),
  };

  const conflicts = [
    ...categories.duplicates.map((slug) => `duplicate category slug:${slug}`),
    ...products.duplicates.map((slug) => `duplicate product slug:${slug}`),
    ...details.duplicates.map((slug) => `duplicate product detail slug:${slug}`),
    ...collectionNames.duplicates.map((name) => `duplicate collection name:${name}`),
    ...attributes.duplicates.map((slug) => `duplicate attribute slug:${slug}`),
  ];
  return {
    mode: "diff",
    readOnly: true,
    generatedAt: new Date().toISOString(),
    resources: { categories: categoryResources, products: productResources, attributes: attributeResources, collections: collectionResources },
    summary: {
      categories: summarize(categoryResources),
      products: summarize(productResources),
      attributes: summarize(attributeResources),
      collections: summarize(collectionResources),
      mediaAssetsPresent: snapshot.media.length,
      pendingMediaIntents: manifest.products.flatMap((product) => product.media).length + manifest.categories.flatMap((category) => category.media).length + manifest.heroes.flatMap((hero) => hero.media).length,
      unexpectedCategories: unexpected.categorySlugs.length,
      unexpectedProducts: unexpected.productSlugs.length,
      unexpectedCollections: unexpected.collectionNames.length,
      conflicts: conflicts.length + [
        ...categoryResources,
        ...productResources,
        ...attributeResources,
        ...collectionResources,
      ].filter((resource) => resource.action === "conflict").length,
    },
    unexpected,
    conflicts,
  };
}

export function formatDemoStoreDiff(result) {
  const s = result.summary;
  const line = (name, counts) => `${name}: ${counts.match} match · ${counts.update} update · ${counts.create} create · ${counts.conflict} conflict`;
  return [
    "Scalius Market read-only production diff",
    "Writes: disabled",
    line("Categories", s.categories),
    line("Products", s.products),
    line("Attributes", s.attributes),
    line("Collections", s.collections),
    `Media: ${s.mediaAssetsPresent} ready assets present · ${s.pendingMediaIntents} manifest intents`,
    `Outside manifest: ${s.unexpectedCategories} categories · ${s.unexpectedProducts} products · ${s.unexpectedCollections} collections`,
    `Conflicts: ${s.conflicts}`,
  ].join("\n");
}
