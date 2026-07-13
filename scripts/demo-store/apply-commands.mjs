import { createHash } from "node:crypto";

function token(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mediaAssociationId(mediaIntent, currentDetail) {
  const stagedMediaId = mediaIntent.staged.mediaId;
  return currentDetail?.media?.find((item) => item.mediaId === stagedMediaId)?.id
    ?? token("pmed_demo", mediaIntent.logicalKey);
}

function stagedProductMedia(product, readiness, currentDetail) {
  return product.media
    .filter((item) => item.role !== "poster")
    .map((item) => ({ ...item, staged: readiness.assets.get(item.logicalKey) }))
    .map((item) => ({
      id: mediaAssociationId(item, currentDetail),
      mediaId: item.staged.mediaId,
      altText: item.altText,
      isPrimary: item.slot === "P",
      logicalKey: item.logicalKey,
      variantValue: item.variantValue,
      kind: item.kind,
    }));
}

function productDiscount(product) {
  if (product.offer?.scope !== "product") return { discountType: "percentage", discountPercentage: 0, discountAmount: 0 };
  return product.offer.type === "fixed"
    ? { discountType: "flat", discountPercentage: 0, discountAmount: product.offer.value }
    : { discountType: "percentage", discountPercentage: product.offer.value, discountAmount: 0 };
}

function sectionPayload(product, currentDetail) {
  return product.additionalSections.map((item) => ({
    id: currentDetail?.additionalInfo?.find((existing) => existing.title === item.title)?.id
      ?? `item-${token("demo", item.logicalKey)}`,
    title: item.title,
    content: item.html,
    sortOrder: item.sortOrder,
  }));
}

export function buildCategoryCommand(category, actual, readiness) {
  const asset = readiness.assets.get(category.media[0].logicalKey);
  const body = {
    name: category.name,
    description: category.description,
    slug: category.slug,
    metaTitle: category.seo.title,
    metaDescription: category.seo.description,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    image: {
      id: asset.mediaId,
      url: asset.url,
      filename: asset.filename,
      size: asset.size,
      createdAt: asset.createdAt,
    },
  };
  if (!actual) return { phase: "categories", logicalKey: category.logicalKey, identity: { slug: category.slug }, action: "create", method: "POST", path: "/api/v1/admin/categories", body, desired: { slug: category.slug } };
  return {
    phase: "categories",
    logicalKey: category.logicalKey,
    identity: { slug: category.slug, id: actual.id },
    action: "update",
    method: "PUT",
    path: `/api/v1/admin/categories/${encodeURIComponent(actual.id)}`,
    body: { ...body, expectedRevision: actual.revision, status: actual.status === "published" ? "published" : "draft" },
    expectedRevision: actual.revision,
    desired: { slug: category.slug },
  };
}

function optionMatrix(product, currentDetail, media) {
  const currentOptions = new Map((currentDetail?.options ?? []).map((option) => [option.name, option]));
  const options = product.options.map((axis, axisIndex) => {
    const current = currentOptions.get(axis.name);
    const id = current?.id ?? token("draft_opt", `${product.slug}:${axisIndex}:${axis.name}`);
    return {
      id,
      name: axis.name,
      standardMapping: axis.mapping,
      values: axis.values.map((value, valueIndex) => ({
        id: current?.values?.find((candidate) => candidate.value === value)?.id
          ?? token("draft_val", `${product.slug}:${axisIndex}:${valueIndex}:${value}`),
        value,
      })),
    };
  });
  const valueId = (axisIndex, value) => options[axisIndex].values.find((item) => item.value === value).id;
  const currentVariants = new Map((currentDetail?.variants ?? []).map((variant) => [
    (variant.selectedOptions ?? []).slice().sort((a, b) => a.position - b.position).map((item) => item.value).join("\u001f"),
    variant,
  ]));
  const associationByValue = new Map(media.filter((item) => item.variantValue).map((item) => [item.variantValue, item.id]));
  const exactCombinationKeys = new Set(product.variantImageIntent.mode === "combinations"
    ? product.variantImageIntent.exactCombinations.map((values) => values.join("\u001f"))
    : []);
  const variants = product.variants.map((variant, variantIndex) => {
    const combinationKey = variant.optionValues.join("\u001f");
    const current = currentVariants.get(combinationKey);
    const skuOffer = product.offer?.scope === "sku" && sameJson(product.offer.combination, variant.optionValues) ? product.offer : null;
    let imageId = null;
    if (product.variantImageIntent.mode === "axis") {
      const axisIndex = product.options.findIndex((axis) => axis.name === product.variantImageIntent.axis);
      const value = variant.optionValues[axisIndex];
      if (product.variantImageIntent.exactValues.includes(value)) imageId = associationByValue.get(value) ?? null;
    } else if (exactCombinationKeys.has(combinationKey)) {
      imageId = current?.imageId ?? null;
    }
    return {
      id: current?.id ?? token("draft_var", `${product.slug}:${variantIndex}:${combinationKey}`),
      selectedOptionValueIds: variant.optionValues.map((value, axisIndex) => valueId(axisIndex, value)),
      imageId,
      sku: current?.sku ?? variant.sku,
      price: variant.price,
      stock: current?.stock ?? variant.inventory.onHand,
      trackInventory: current?.trackInventory ?? true,
      weight: current?.weight ?? null,
      barcode: current?.barcode ?? null,
      barcodeType: current?.barcodeType ?? null,
      discountType: skuOffer?.type === "fixed" ? "flat" : "percentage",
      discountPercentage: skuOffer?.type === "percentage" ? skuOffer.value : 0,
      discountAmount: skuOffer?.type === "fixed" ? skuOffer.value : 0,
    };
  });
  return { options, variants };
}

export function buildProductCommands(product, actualListItem, currentDetail, { readiness, categoryId, brandAttributeId }) {
  if (!categoryId) throw new Error(`Category must be resolved before product ${product.slug}.`);
  if (!brandAttributeId) throw new Error("The filterable Brand attribute must be reconciled before products.");
  if (product.retainedProductId && actualListItem?.id !== product.retainedProductId) throw new Error(`Retained product identity changed for ${product.slug}.`);
  if (actualListItem && !currentDetail) throw new Error(`Current product detail is required for ${product.slug}.`);
  const mediaWithIntent = stagedProductMedia(product, readiness, currentDetail);
  if (product.retainedProductId) {
    const submittedMediaIds = new Set(mediaWithIntent.map((item) => readiness.assets.get(item.logicalKey).mediaId));
    const removed = (currentDetail.media ?? []).filter((item) => item.status === "ready" && !submittedMediaIds.has(item.mediaId));
    if (removed.length) throw new Error(`Retained product ${product.slug} would lose existing media.`);
  }
  const media = mediaWithIntent.map((item) => ({
    id: item.id,
    mediaId: item.mediaId,
    altText: item.altText,
    isPrimary: item.isPrimary,
  }));
  const base = {
    name: product.name,
    description: product.descriptionHtml,
    price: product.price,
    categoryId,
    isActive: currentDetail?.isActive ?? false,
    ...productDiscount(product),
    freeDelivery: product.freeDelivery,
    metaTitle: product.seo.title,
    metaDescription: product.seo.description,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    excludeFromProductFeed: false,
    productCondition: product.condition,
    slug: product.slug,
    media,
    attributes: [
      ...(currentDetail?.attributes ?? []).filter((item) => item.attributeId !== brandAttributeId),
      { attributeId: brandAttributeId, value: product.brand },
    ],
    additionalInfo: sectionPayload(product, currentDetail),
  };
  if (!actualListItem) {
    return [{
      phase: "products",
      logicalKey: product.logicalKey,
      identity: { slug: product.slug },
      action: "create",
      method: "POST",
      path: "/api/v1/admin/products",
      body: product.options.length ? { ...base, optionMatrix: optionMatrix(product, null, mediaWithIntent) } : base,
      desired: { slug: product.slug },
      initializeSimpleStock: product.options.length === 0 ? product.variants[0].inventory.onHand : null,
    }];
  }
  const baseCommand = {
    phase: "products",
    logicalKey: product.logicalKey,
    identity: { slug: product.slug, id: actualListItem.id },
    action: "update",
    method: "PUT",
    path: `/api/v1/admin/products/${encodeURIComponent(actualListItem.id)}`,
    body: { ...base, id: actualListItem.id, expectedAggregateRevision: currentDetail.aggregateRevision },
    expectedRevision: currentDetail.aggregateRevision,
    desired: { slug: product.slug },
  };
  if (product.retainedProductId || !product.options.length) return [baseCommand];
  return [baseCommand, {
    phase: "product-options",
    logicalKey: `${product.logicalKey}:options`,
    identity: { slug: product.slug, id: actualListItem.id },
    action: "update",
    method: "PUT",
    path: `/api/v1/admin/products/${encodeURIComponent(actualListItem.id)}/options/matrix`,
    body: { ...optionMatrix(product, currentDetail, mediaWithIntent), expectedAggregateRevision: "REFETCH_AFTER_BASE" },
    expectedRevision: "REFETCH_AFTER_BASE",
    desired: { slug: product.slug },
  }];
}

export function buildCollectionCommand(collection, actual, { categoryIds, productIds, offerSlugs = [], newNoteworthySlugs = [] }) {
  const dynamicCategories = collection.logicalKey === "collection:everyday-carry"
    ? [categoryIds.get("bags-carry"), categoryIds.get("desk-mobile-tech")]
    : collection.logicalKey === "collection:home-refresh"
      ? [categoryIds.get("home-living"), categoryIds.get("kitchen-table")]
      : [];
  const manualSlugs = collection.logicalKey === "collection:weekend-ready"
    ? ["rider-court-trainers", "monsoon-trail-sandals", "rove-packable-flats", "transit-daypack-18l", "tidal-rolltop-backpack", "weekender-duffel-35l", "vault-10k-power-bank", "echo-mini-bluetooth-speaker"]
    : collection.logicalKey === "collection:offers-worth-opening"
      ? offerSlugs.slice(0, 12)
      : newNoteworthySlugs.slice(0, collection.limit);
  const config = {
    source: collection.source,
    categoryIds: dynamicCategories.filter(Boolean),
    productIds: collection.source === "manual" ? manualSlugs.map((slug) => productIds.get(slug)).filter(Boolean) : [],
    maxProducts: collection.limit,
    title: collection.name,
    subtitle: "",
  };
  const body = { name: collection.name, presentation: collection.presentation, isActive: false, canonicalPath: null, noIndex: false, excludeFromSitemap: false, config };
  if (!actual) return { phase: "collections", logicalKey: collection.logicalKey, identity: { name: collection.name }, action: "create", method: "POST", path: "/api/v1/admin/collections", body, desired: { name: collection.name } };
  return { phase: "collections", logicalKey: collection.logicalKey, identity: { name: collection.name, id: actual.id }, action: "update", method: "PUT", path: `/api/v1/admin/collections/${encodeURIComponent(actual.id)}`, body: { ...body, expectedVersion: actual.version }, expectedRevision: actual.version, desired: { name: collection.name } };
}

export function buildThemeCommand(intent, currentTheme) {
  if (!intent) return null;
  return { phase: "settings", logicalKey: "settings:theme", identity: { id: "theme" }, action: "update", method: "POST", path: "/api/v1/admin/settings/theme", body: { colors: intent.colors, expectedRevision: currentTheme.revision }, expectedRevision: currentTheme.revision, desired: { colors: intent.colors } };
}

export function buildHeroCommands(manifest, currentHeroes, readiness, resolveDestination) {
  return ["desktop", "mobile"].map((type) => {
    const current = currentHeroes.find((hero) => hero.type === type);
    const images = manifest.heroes.map((hero) => {
      const media = hero.media.find((item) => item.logicalKey.endsWith(`:${type}`));
      const asset = readiness.assets.get(media.logicalKey);
      return { id: token("slide_demo", `${hero.logicalKey}:${type}`), url: asset.url, title: hero.title, link: resolveDestination(hero.destination) };
    });
    return current
      ? { phase: "settings", logicalKey: `settings:hero:${type}`, identity: { id: current.id }, action: "update", method: "PUT", path: `/api/v1/admin/settings/hero-sliders/${encodeURIComponent(current.id)}`, body: { expectedRevision: current.revision, images, isActive: false }, expectedRevision: current.revision, desired: { type } }
      : { phase: "settings", logicalKey: `settings:hero:${type}`, identity: { type }, action: "create", method: "POST", path: "/api/v1/admin/settings/hero-sliders", body: { type, images, isActive: false }, desired: { type } };
  });
}

export function buildSimpleStockInitializationCommand(product, detail) {
  if (product.options.length || product.retainedProductId) return null;
  const variants = (detail?.variants ?? []).filter((variant) => !variant.deletedAt);
  if (variants.length !== 1 || variants[0].isDefault !== true) throw new Error(`Simple product ${product.slug} does not have exactly one default SKU.`);
  const variant = variants[0];
  return {
    phase: "product-stock-initialization",
    logicalKey: `${product.logicalKey}:initial-stock`,
    identity: { slug: product.slug, id: detail.id, variantId: variant.id },
    action: "update",
    method: "PUT",
    path: `/api/v1/admin/products/${encodeURIComponent(detail.id)}/variants/${encodeURIComponent(variant.id)}`,
    body: {
      selectedOptionValueIds: [], imageId: null, weight: variant.weight ?? null,
      sku: variant.sku, price: product.price, stock: product.variants[0].inventory.onHand,
      trackInventory: true, barcode: variant.barcode, barcodeType: variant.barcodeType,
      discountType: "percentage", discountPercentage: 0, discountAmount: 0,
      expectedAggregateRevision: detail.aggregateRevision,
    },
    expectedRevision: detail.aggregateRevision,
    desired: { slug: product.slug, stock: product.variants[0].inventory.onHand },
  };
}

export function assertUnversionedSettingsExcluded(intent) {
  if (intent?.header || intent?.footer) throw new Error("Header/footer writes are not revisioned and remain blocked from automated apply.");
}
