import { createHash } from "node:crypto";

import { assertValidDemoStoreManifest } from "./validate.mjs";

const API = "/api/v1/admin";

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function stableDraftId(prefix, logicalKey) {
  return `${prefix}_${hash(logicalKey)}`;
}

export function commandRef(logicalKey, field = "id") {
  return { $ref: logicalKey, field };
}

function command(logicalKey, phase, method, path, body, extra = {}) {
  return {
    id: stableDraftId("cmd", `${phase}:${logicalKey}`),
    logicalKey,
    phase,
    method,
    path,
    body,
    ...extra,
  };
}

function currentBy(rows, key) {
  return new Map((rows ?? []).map((row) => [row[key], row]));
}

function productAssociationId(product, media, existing) {
  if (existing) return commandRef(`bound-product-media:${product.slug}:${media.logicalKey}`);
  return stableDraftId("pmed_demo", `${product.logicalKey}:${media.logicalKey}`);
}

function mediaAssetRef(media) {
  return commandRef(`media:${media.logicalKey}`);
}

function categoryImageRef(category) {
  return commandRef(`media:${category.media[0].logicalKey}`, "categoryImage");
}

function productMediaPayload(product, existing) {
  return product.media
    .filter((media) => media.role !== "poster")
    .map((media) => ({
      id: productAssociationId(product, media, existing),
      mediaId: mediaAssetRef(media),
      altText: media.altText,
      isPrimary: media.slot === "P",
    }));
}

function optionDrafts(product, existing) {
  return product.options.map((axis, axisIndex) => ({
    id: existing
      ? commandRef(`current-option:${product.slug}:${axis.name}`)
      : stableDraftId("draft_option", `${product.logicalKey}:${axisIndex}:${axis.name}`),
    name: axis.name,
    standardMapping: axis.mapping,
    values: axis.values.map((value, valueIndex) => ({
      id: existing
        ? commandRef(`current-option-value:${product.slug}:${axis.name}:${value}`)
        : stableDraftId("draft_value", `${product.logicalKey}:${axisIndex}:${valueIndex}:${value}`),
      value,
    })),
  }));
}

function variantImageId(product, variant, existing) {
  const intent = product.variantImageIntent;
  if (intent.mode === "fallback") return null;
  if (intent.mode === "combinations") {
    const exact = intent.exactCombinations.some((combination) =>
      combination.every((value, index) => value === variant.optionValues[index]),
    );
    if (!exact) return null;
    const matchingMedia = product.media.find((media) =>
      media.variantValue && variant.optionValues.includes(media.variantValue),
    );
    return matchingMedia
      ? productAssociationId(product, matchingMedia, existing)
      : null;
  }
  const axisIndex = product.options.findIndex((axis) => axis.name === intent.axis);
  const value = variant.optionValues[axisIndex];
  if (!intent.exactValues.includes(value)) return null;
  const media = product.media.find((candidate) => candidate.slot === `V:${value}`);
  return media ? productAssociationId(product, media, existing) : null;
}

function variantOffer(product, variant) {
  const offer = product.offer;
  const matches = offer?.scope === "sku" && offer.combination.every(
    (value, index) => value === variant.optionValues[index],
  );
  if (!matches) {
    return { discountType: "percentage", discountPercentage: 0, discountAmount: null };
  }
  return offer.type === "fixed"
    ? { discountType: "flat", discountPercentage: null, discountAmount: offer.value }
    : { discountType: "percentage", discountPercentage: offer.value, discountAmount: null };
}

function productOptionMatrix(product, existing) {
  if (product.options.length === 0) return undefined;
  const options = optionDrafts(product, existing);
  return {
    options,
    variants: product.variants.map((variant) => ({
      id: existing
        ? commandRef(`current-variant:${variant.logicalKey}`)
        : stableDraftId("draft_variant", variant.logicalKey),
      selectedOptionValueIds: variant.optionValues.map((value, axisIndex) => {
        const option = options[axisIndex];
        return option.values.find((candidate) => candidate.value === value).id;
      }),
      imageId: variantImageId(product, variant, existing),
      sku: existing ? commandRef(`current-variant:${variant.logicalKey}`, "sku") : variant.sku,
      price: variant.price,
      stock: existing
        ? commandRef(`current-variant:${variant.logicalKey}`, "stock")
        : variant.inventory.onHand,
      trackInventory: existing ? commandRef(`current-variant:${variant.logicalKey}`, "trackInventory") : true,
      weight: existing ? commandRef(`current-variant:${variant.logicalKey}`, "weight") : null,
      barcode: existing
        ? commandRef(`current-variant:${variant.logicalKey}`, "barcode")
        : null,
      barcodeType: existing
        ? commandRef(`current-variant:${variant.logicalKey}`, "barcodeType")
        : null,
      ...variantOffer(product, variant),
    })),
  };
}

function productDiscount(product) {
  const offer = product.offer;
  if (offer?.scope !== "product") {
    return { discountType: "percentage", discountPercentage: null, discountAmount: null };
  }
  return offer.type === "fixed"
    ? { discountType: "flat", discountPercentage: null, discountAmount: offer.value }
    : { discountType: "percentage", discountPercentage: offer.value, discountAmount: null };
}

function productBasePayload(product, categoryId, { isActive, expectedAggregateRevision, id, existing = false } = {}) {
  return {
    ...(id ? { id } : {}),
    ...(expectedAggregateRevision ? { expectedAggregateRevision } : {}),
    name: product.name,
    description: product.descriptionHtml,
    price: product.price,
    categoryId,
    isActive,
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
    media: productMediaPayload(product, existing),
    attributes: existing
      ? commandRef(`current-product:${product.slug}`, "attributesWithBrand")
      : [{ attributeId: commandRef("attribute:brand"), value: product.brand }],
    additionalInfo: product.additionalSections.map((section) => ({
      id: existing
        ? commandRef(`current-section:${section.logicalKey}`)
        : stableDraftId("item-demo", section.logicalKey),
      title: section.title,
      content: section.html,
      sortOrder: section.sortOrder,
    })),
    ...(existing ? {
      acknowledgedSkuImageRemovalIds: commandRef(`current-product:${product.slug}`, "removedSkuImageIds"),
    } : {}),
  };
}

function categoryCommands(manifest, current) {
  const bySlug = currentBy(current.categories, "slug");
  return manifest.categories.map((category) => {
    const existing = bySlug.get(category.slug);
    const body = {
      name: category.name,
      description: category.description,
      slug: category.slug,
      metaTitle: category.seo.title,
      metaDescription: category.seo.description,
      canonicalPath: null,
      noIndex: false,
      excludeFromSitemap: false,
      image: categoryImageRef(category),
      ...(existing ? { expectedRevision: existing.revision, status: existing.status } : {}),
    };
    return command(
      category.logicalKey,
      "categories",
      existing ? "PUT" : "POST",
      existing ? `${API}/categories/${existing.id}` : `${API}/categories`,
      body,
      {
        produces: { id: existing?.id ?? stableDraftId("draft_category", category.logicalKey) },
        preconditions: existing ? { expectedRevision: existing.revision } : { exactSlugAbsent: category.slug },
      },
    );
  });
}

function attributeCommands(current) {
  const brands = (current.attributes ?? []).filter((attribute) => attribute.slug === "brand");
  if (brands.length > 1) throw new Error("Brand attribute identity is ambiguous.");
  const existing = brands[0];
  if (existing) {
    if (existing.name !== "Brand" || existing.filterable !== true) {
      throw new Error("Brand attribute exists but is not the exact filterable Brand definition; unversioned attribute updates remain blocked.");
    }
    return [];
  }
  return [command("attribute:brand", "vocabulary", "POST", `${API}/attributes`, {
    name: "Brand",
    slug: "brand",
    filterable: true,
    options: [],
  }, {
    preconditions: { exactSlugAbsent: "brand" },
    produces: { id: stableDraftId("draft_attribute", "attribute:brand") },
  })];
}

function productCommands(manifest, current) {
  const details = currentBy(current.productDetails, "slug");
  const commands = [];
  for (const product of manifest.products) {
    const existing = details.get(product.slug);
    const retained = Boolean(product.retainedProductId);
    if (retained && existing && existing.id !== product.retainedProductId) {
      throw new Error(`Retained product ${product.slug} resolved to ${existing.id}, expected ${product.retainedProductId}.`);
    }
    const productId = existing?.id ?? product.retainedProductId ?? stableDraftId("draft_product", product.logicalKey);
    const categoryId = commandRef(`category:${product.categorySlug}`);
    const revision = existing?.aggregateRevision ?? commandRef(`current-product:${product.slug}`, "aggregateRevision");
    const baseLogicalKey = `${product.logicalKey}:base`;

    if (existing || retained) {
      const payload = productBasePayload(product, categoryId, {
        id: productId,
        isActive: commandRef(`current-product:${product.slug}`, "isActive"),
        expectedAggregateRevision: revision,
        existing: true,
      });
      commands.push(command(baseLogicalKey, "products", "PUT", `${API}/products/${productId}`, payload, {
        dependsOn: [`category:${product.categorySlug}`],
        produces: { id: productId },
        preconditions: { expectedAggregateRevision: revision },
        preservation: retained ? {
          retainedProductId: product.retainedProductId,
          preserveSkuIds: true,
          preserveOptionValueIds: true,
          preserveMediaAssociationIds: false,
          preserveSkuImageSemantics: true,
          preserveInventoryLedger: true,
          preserveReservations: true,
        } : undefined,
      }));
      if (product.options.length > 0) {
        commands.push(command(`${product.logicalKey}:matrix`, "products", "PUT", `${API}/products/${productId}/options/matrix`, {
          ...productOptionMatrix(product, true),
          expectedAggregateRevision: commandRef(baseLogicalKey, "aggregateRevision"),
        }, {
          dependsOn: [baseLogicalKey],
          preconditions: { expectedAggregateRevision: commandRef(baseLogicalKey, "aggregateRevision") },
          preservation: retained ? {
            preserveSkuIds: true,
            preserveInventoryLedger: true,
            preserveReservations: true,
            adoptCurrentVariantFacts: true,
            noStockReset: true,
          } : undefined,
        }));
      } else if (!retained && current.resumeSimpleSlugs?.includes(product.slug)) {
        const variant = product.variants[0];
        const simpleKey = `${product.logicalKey}:simple-sku`;
        commands.push(command(simpleKey, "products", "PUT", `${API}/products/${productId}/variants/{defaultVariantId}`, {
          selectedOptionValueIds: [],
          imageId: null,
          weight: null,
          sku: commandRef(`current-variant:${variant.logicalKey}`, "sku"),
          price: variant.price,
          stock: variant.inventory.onHand,
          trackInventory: true,
          discountType: "percentage",
          discountPercentage: 0,
          discountAmount: null,
          expectedAggregateRevision: commandRef(baseLogicalKey, "aggregateRevision"),
        }, {
          pathBindings: { defaultVariantId: commandRef(`current-product:${product.slug}`, "defaultVariantId") },
          dependsOn: [baseLogicalKey],
          preconditions: {
            expectedAggregateRevision: commandRef(baseLogicalKey, "aggregateRevision"),
            preserveGeneratedBarcode: true,
          },
        }));
      }
      continue;
    }

    const createBody = productBasePayload(product, categoryId, { isActive: false });
    const matrix = productOptionMatrix(product, false);
    if (matrix) createBody.optionMatrix = matrix;
    commands.push(command(baseLogicalKey, "products", "POST", `${API}/products`, createBody, {
      dependsOn: [`category:${product.categorySlug}`],
      produces: { id: productId, aggregateRevision: 1 },
      preconditions: { exactSlugAbsent: product.slug },
    }));

    let activationRevisionRef = commandRef(baseLogicalKey, "aggregateRevision");
    const activationDependencies = [baseLogicalKey];
    if (!matrix) {
      const variant = product.variants[0];
      const simpleKey = `${product.logicalKey}:simple-sku`;
      commands.push(command(simpleKey, "products", "PUT", `${API}/products/{productId}/variants/{defaultVariantId}`, {
        selectedOptionValueIds: [],
        imageId: null,
        weight: null,
        sku: variant.sku,
        price: variant.price,
        stock: variant.inventory.onHand,
        trackInventory: true,
        discountType: "percentage",
        discountPercentage: 0,
        discountAmount: null,
        expectedAggregateRevision: activationRevisionRef,
      }, {
        pathBindings: {
          productId: commandRef(baseLogicalKey),
          defaultVariantId: commandRef(baseLogicalKey, "defaultVariantId"),
        },
        dependsOn: [baseLogicalKey],
        preconditions: {
          expectedAggregateRevision: activationRevisionRef,
          preserveGeneratedBarcode: true,
        },
      }));
      activationRevisionRef = commandRef(simpleKey, "aggregateRevision");
      activationDependencies.push(simpleKey);
    }
    const activateKey = `${product.logicalKey}:activate`;
    commands.push(command(activateKey, "activation", "PUT", `${API}/products/{productId}`, productBasePayload(product, categoryId, {
      id: commandRef(baseLogicalKey),
      isActive: true,
      expectedAggregateRevision: activationRevisionRef,
    }), {
      dependsOn: activationDependencies,
      pathBindings: { productId: commandRef(baseLogicalKey) },
      preconditions: { expectedAggregateRevision: activationRevisionRef },
    }));
  }
  return commands;
}

const weekendSlugs = [
  "rider-court-trainers", "monsoon-trail-sandals", "rove-packable-flats",
  "transit-daypack-18l", "tidal-rolltop-backpack", "weekender-duffel-35l",
  "vault-10k-power-bank", "echo-mini-bluetooth-speaker",
];

function collectionMembers(collection, manifest) {
  if (collection.logicalKey === "collection:new-noteworthy") {
    const firstTwo = manifest.categories.flatMap((category) =>
      manifest.products.filter((product) => product.categorySlug === category.slug).slice(0, 2),
    );
    const extras = ["footwear", "home-living"].map((categorySlug) =>
      manifest.products.filter((product) => product.categorySlug === categorySlug)[2],
    );
    return firstTwo.concat(extras);
  }
  if (collection.logicalKey === "collection:weekend-ready") {
    return weekendSlugs.map((slug) => manifest.products.find((product) => product.slug === slug));
  }
  if (collection.logicalKey === "collection:offers-worth-opening") {
    return manifest.products.filter((product) => product.offer).slice(0, collection.limit);
  }
  return [];
}

function collectionCategories(collection) {
  if (collection.logicalKey === "collection:everyday-carry") return ["bags-carry", "desk-mobile-tech"];
  if (collection.logicalKey === "collection:home-refresh") return ["home-living", "kitchen-table"];
  return [];
}

function collectionCommands(manifest, current) {
  const byName = currentBy(current.collections, "name");
  return manifest.collections.map((collection) => {
    const existing = byName.get(collection.name);
    const config = {
      source: collection.source,
      categoryIds: collectionCategories(collection).map((slug) => commandRef(`category:${slug}`)),
      productIds: collectionMembers(collection, manifest).map((product) => commandRef(`${product.logicalKey}:base`)),
      maxProducts: collection.limit,
      title: collection.name,
      subtitle: "",
    };
    const body = {
      ...(existing ? { expectedVersion: existing.version } : {}),
      name: collection.name,
      presentation: collection.presentation,
      isActive: existing?.isActive ?? false,
      canonicalPath: null,
      noIndex: false,
      excludeFromSitemap: false,
      config,
    };
    return command(collection.logicalKey, "collections", existing ? "PUT" : "POST", existing ? `${API}/collections/${existing.id}` : `${API}/collections`, body, {
      dependsOn: [
        ...collectionCategories(collection).map((slug) => `category:${slug}`),
        ...collectionMembers(collection, manifest).map((product) => `${product.logicalKey}:base`),
      ],
      preconditions: existing ? { expectedVersion: existing.version } : { exactNameAbsent: collection.name },
      produces: { id: existing?.id ?? stableDraftId("draft_collection", collection.logicalKey) },
    });
  });
}

function heroCommands(manifest, current) {
  const existingByType = new Map((current.heroes ?? []).map((hero) => [hero.type, hero]));
  return ["desktop", "mobile"].map((type) => {
    const existing = existingByType.get(type);
    const images = manifest.heroes.map((hero) => ({
      id: stableDraftId("slide_demo", `${hero.logicalKey}:${type}`),
      url: commandRef(`media:${hero.logicalKey}:${type}`, "url"),
      title: `${hero.title}. ${hero.copy}`,
      link: { $routeRef: hero.destination },
    }));
    return command(`hero-slider:${type}`, "presentation", existing ? "PUT" : "POST", existing ? `${API}/settings/hero-sliders/${existing.id}` : `${API}/settings/hero-sliders`, {
      ...(existing ? { expectedRevision: existing.revision } : { type }),
      images,
      isActive: existing?.isActive ?? false,
    }, {
      dependsOn: manifest.heroes.map((hero) => hero.destination),
      preconditions: existing ? { expectedRevision: existing.revision } : { sliderTypeAbsent: type },
    });
  });
}

function publicationCommands(manifest, categoryBaseCommands) {
  return manifest.categories.map((category) => {
    const base = categoryBaseCommands.find((item) => item.logicalKey === category.logicalKey);
    const currentStatus = base.body.status;
    if (currentStatus === "published") return null;
    const firstProduct = manifest.products.find((product) => product.categorySlug === category.slug);
    const productDependency = firstProduct.retainedProductId
      ? `${firstProduct.logicalKey}:base`
      : `${firstProduct.logicalKey}:activate`;
    return command(`${category.logicalKey}:publish`, "publication", "PATCH", `${API}/categories/{categoryId}/status`, {
      expectedRevision: commandRef(category.logicalKey, "revision"),
      status: "published",
    }, {
      pathBindings: { categoryId: commandRef(category.logicalKey) },
      dependsOn: [category.logicalKey, productDependency],
      preconditions: { expectedRevision: commandRef(category.logicalKey, "revision") },
    });
  }).filter(Boolean);
}

export function compileDemoStoreAdminCommands(manifest, { current = {} } = {}) {
  assertValidDemoStoreManifest(manifest);
  const normalizedCurrent = {
    categories: current.categories ?? [],
    productDetails: current.productDetails ?? [],
    collections: current.collections ?? [],
    heroes: current.heroes ?? current.presentation?.heroes ?? [],
    attributes: current.attributes ?? [],
    resumeSimpleSlugs: current.resumeSimpleSlugs ?? [],
  };
  const attributes = attributeCommands(normalizedCurrent);
  const categories = categoryCommands(manifest, normalizedCurrent);
  const products = productCommands(manifest, normalizedCurrent);
  const collections = collectionCommands(manifest, normalizedCurrent);
  const heroes = heroCommands(manifest, normalizedCurrent);
  const publication = publicationCommands(manifest, categories);
  const commands = [...attributes, ...categories, ...products, ...publication, ...collections, ...heroes];
  return {
    mode: "compile",
    writesEnabled: false,
    schemaVersion: manifest.schemaVersion,
    commands,
    summary: commands.reduce((summary, item) => {
      summary.total += 1;
      summary.byPhase[item.phase] = (summary.byPhase[item.phase] ?? 0) + 1;
      return summary;
    }, { total: 0, byPhase: {} }),
    retainedResources: manifest.products.filter((product) => product.retainedProductId).map((product) => ({
      logicalKey: product.logicalKey,
      productId: product.retainedProductId,
      preservationRequired: true,
    })),
  };
}

export function formatDemoStoreCompile(result) {
  const orderedPhases = [
    "vocabulary", "categories", "products", "activation",
    "publication", "collections", "presentation",
  ];
  const phases = orderedPhases
    .filter((phase) => result.summary.byPhase[phase])
    .map((phase) => `${phase} ${result.summary.byPhase[phase]}`)
    .join(" · ");
  return [
    "Scalius Market compiled admin intent",
    "Writes: disabled",
    `Commands: ${result.summary.total} · ${phases}`,
    `Retained boundaries: ${result.retainedResources.length}`,
    "Execution: unavailable from this command",
  ].join("\n");
}
