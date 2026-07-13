import { DEMO_STORE_CONTRACT, demoStoreManifest } from "./manifest.mjs";

const ALLOWED_MAPPINGS = new Set(["size", "color", "material", "pattern", "none"]);
const BUYER_COPY_PLACEHOLDER_PATTERN = /\b(?:pending|to be confirmed|will be confirmed|will be stated|final sourced|final product|final pack|unverified certification|not promised)\b/i;

function normalized(value) {
  return String(value).normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function plainText(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values.map(normalized)) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function combinationKey(values) {
  return values.map(normalized).join("\u001f");
}

function expectUnique(errors, label, values) {
  const duplicates = duplicateValues(values);
  if (duplicates.length) errors.push(`${label} must be unique; duplicates: ${duplicates.join(", ")}`);
}

function expectCount(errors, label, actual, expected) {
  if (actual !== expected) errors.push(`${label} must be ${expected}; received ${actual}`);
}

function validateBuyerCopy(errors, label, value) {
  if (BUYER_COPY_PLACEHOLDER_PATTERN.test(value)) {
    errors.push(`${label} contains unfinished sourcing or placeholder language`);
  }
}

function validateProduct(product, categories, errors) {
  const prefix = `Product ${product.slug}`;
  if (!categories.has(product.categorySlug)) errors.push(`${prefix} references unknown category ${product.categorySlug}`);
  if (!Number.isInteger(product.price) || product.price <= 0) errors.push(`${prefix} price must be a positive BDT integer`);
  if (product.currency !== "BDT") errors.push(`${prefix} currency must be BDT`);
  if (!/^<p>[\s\S]+<\/p>$/.test(product.descriptionHtml) || plainText(product.descriptionHtml).length < 120) {
    errors.push(`${prefix} must have substantial semantic paragraph copy`);
  }
  if (!product.brand?.trim()) errors.push(`${prefix} needs an explicit brand`);
  if (!product.seo?.title?.trim() || !product.seo?.description?.trim()) errors.push(`${prefix} needs SEO title and description`);
  if (product.seo?.description && (product.seo.description.length < 70 || product.seo.description.length > 200)) {
    errors.push(`${prefix} SEO description must be 70–200 characters`);
  }
  if (product.seo?.description === plainText(product.descriptionHtml)) {
    errors.push(`${prefix} SEO description must summarize rather than duplicate the full description`);
  }
  validateBuyerCopy(errors, `${prefix} description`, plainText(product.descriptionHtml));
  validateBuyerCopy(errors, `${prefix} SEO description`, product.seo?.description ?? "");

  expectUnique(errors, `${prefix} option names`, product.options.map((axis) => axis.name));
  if (product.options.length > 2) errors.push(`${prefix} exceeds the current two-axis option contract`);
  for (const axis of product.options) {
    if (!ALLOWED_MAPPINGS.has(axis.mapping)) errors.push(`${prefix} option ${axis.name} has invalid mapping ${axis.mapping}`);
    if (!axis.values.length) errors.push(`${prefix} option ${axis.name} has no values`);
    expectUnique(errors, `${prefix} option ${axis.name} values`, axis.values);
  }

  const variantKeys = product.variants.map((variant) => combinationKey(variant.optionValues));
  expectUnique(errors, `${prefix} combinations`, variantKeys);
  for (const variant of product.variants) {
    if (variant.optionValues.length !== product.options.length) errors.push(`${prefix} variant ${variant.sku} has the wrong axis count`);
    variant.optionValues.forEach((value, index) => {
      if (!product.options[index]?.values.includes(value)) errors.push(`${prefix} variant ${variant.sku} uses unknown option value ${value}`);
    });
    if (!Number.isInteger(variant.price) || variant.price <= 0) errors.push(`${prefix} variant ${variant.sku} price must be positive`);
    if (variant.inventory.mode === "tracked" && (!Number.isInteger(variant.inventory.onHand) || variant.inventory.onHand < 0)) {
      errors.push(`${prefix} variant ${variant.sku} stock must be a non-negative integer`);
    }
  }

  for (const omitted of product.omittedCombinations) {
    if (omitted.length !== product.options.length) errors.push(`${prefix} omitted combination has the wrong axis count`);
    omitted.forEach((value, index) => {
      if (!product.options[index]?.values.includes(value)) errors.push(`${prefix} omitted combination uses unknown option value ${value}`);
    });
    if (variantKeys.includes(combinationKey(omitted))) errors.push(`${prefix} omitted combination ${omitted.join(" / ")} is still active`);
  }
  if (product.stockProfile !== "retained" && !product.variants.some((variant) => variant.inventory.onHand > 0)) {
    errors.push(`${prefix} must have at least one available SKU`);
  }

  const primary = product.media.filter((media) => media.slot === "P");
  if (primary.length !== 1) errors.push(`${prefix} must declare exactly one primary media slot`);
  expectUnique(errors, `${prefix} media logical keys`, product.media.map((media) => media.logicalKey));
  for (const media of product.media) {
    if (!media.altText?.trim() || media.altText.trim().length < 18) errors.push(`${prefix} media ${media.logicalKey} needs descriptive alt text`);
    if (media.kind === "video" && !media.caption?.trim()) errors.push(`${prefix} video ${media.logicalKey} needs a caption`);
  }

  const imageIntent = product.variantImageIntent;
  if (imageIntent.mode === "axis") {
    const axis = product.options.find((candidate) => candidate.name === imageIntent.axis);
    if (!axis) errors.push(`${prefix} image intent references unknown axis ${imageIntent.axis}`);
    for (const value of imageIntent.exactValues) {
      if (!axis?.values.includes(value)) errors.push(`${prefix} image intent references unknown value ${value}`);
      if (!product.media.some((media) => media.slot === `V:${value}`)) errors.push(`${prefix} image intent lacks V:${value} media`);
    }
  } else if (imageIntent.mode === "combinations") {
    for (const combination of imageIntent.exactCombinations) {
      if (!variantKeys.includes(combinationKey(combination))) errors.push(`${prefix} image intent references unavailable combination ${combination.join(" / ")}`);
    }
  }

  expectUnique(errors, `${prefix} section logical keys`, product.additionalSections.map((item) => item.logicalKey));
  product.additionalSections.forEach((item, index) => {
    if (item.sortOrder !== index) errors.push(`${prefix} sections must have dense zero-based sort order`);
    if (!item.title?.trim() || plainText(item.html).length < 35) errors.push(`${prefix} section ${item.logicalKey} is incomplete`);
    validateBuyerCopy(errors, `${prefix} section ${item.logicalKey}`, plainText(item.html));
  });

  if (product.offer) {
    if (!Number.isFinite(product.offer.value) || product.offer.value <= 0) errors.push(`${prefix} offer must be positive`);
    if (product.offer.type === "percentage" && product.offer.value >= 100) errors.push(`${prefix} percentage offer must be below 100`);
    if (product.offer.type === "fixed" && product.offer.value >= product.price) errors.push(`${prefix} fixed offer must remain below price`);
    if (product.offer.scope === "sku" && !variantKeys.includes(combinationKey(product.offer.combination ?? []))) {
      errors.push(`${prefix} SKU offer references an unavailable combination`);
    }
  }
}

export function validateDemoStoreManifest(manifest = demoStoreManifest) {
  const errors = [];
  const contract = DEMO_STORE_CONTRACT;
  const categorySlugs = new Set(manifest.categories.map((category) => category.slug));
  const productsByCategory = new Map(manifest.categories.map((category) => [category.slug, []]));

  expectCount(errors, "Category count", manifest.categories.length, contract.categories);
  expectCount(errors, "Product count", manifest.products.length, contract.products);
  expectCount(errors, "Collection count", manifest.collections.length, contract.collections);
  expectUnique(errors, "Category slugs", manifest.categories.map((category) => category.slug));
  expectUnique(errors, "Product slugs", manifest.products.map((product) => product.slug));
  expectUnique(errors, "Product logical keys", manifest.products.map((product) => product.logicalKey));

  for (const category of manifest.categories) {
    if (category.status !== "published") errors.push(`Category ${category.slug} must target published status`);
    if (!category.description?.trim() || category.description.length < 120) errors.push(`Category ${category.slug} needs substantial copy`);
    if (!category.brand?.trim()) errors.push(`Category ${category.slug} needs a house brand`);
    if (!category.seo?.description || category.seo.description.length < 70 || category.seo.description.length > 200) {
      errors.push(`Category ${category.slug} SEO description must be 70–200 characters`);
    }
    if (category.seo?.description === category.description) {
      errors.push(`Category ${category.slug} SEO description must summarize rather than duplicate category copy`);
    }
    validateBuyerCopy(errors, `Category ${category.slug} description`, category.description ?? "");
    validateBuyerCopy(errors, `Category ${category.slug} SEO description`, category.seo?.description ?? "");
  }

  for (const product of manifest.products) {
    productsByCategory.get(product.categorySlug)?.push(product);
    validateProduct(product, categorySlugs, errors);
  }
  for (const [categorySlug, products] of productsByCategory) {
    expectCount(errors, `Products in ${categorySlug}`, products.length, contract.productsPerCategory);
  }

  const variants = manifest.products.flatMap((product) => product.variants);
  const optionedProducts = manifest.products.filter((product) => product.options.length > 0);
  const simpleProducts = manifest.products.filter((product) => product.options.length === 0);
  const productMedia = manifest.products.flatMap((product) => product.media);
  const presentationMedia = [
    ...manifest.categories.flatMap((category) => category.media),
    ...manifest.heroes.flatMap((hero) => hero.media),
  ];
  const allMedia = [...productMedia, ...presentationMedia];
  const additionalSections = manifest.products.flatMap((product) => product.additionalSections);
  const productsWithTwoOrMoreSections = manifest.products.filter((product) => product.additionalSections.length >= 2);
  const offers = manifest.products.filter((product) => product.offer);

  expectCount(errors, "SKU count", variants.length, contract.skus);
  expectCount(errors, "Optioned product count", optionedProducts.length, contract.optionedProducts);
  expectCount(errors, "Simple product count", simpleProducts.length, contract.simpleProducts);
  expectCount(errors, "Active offer count", offers.length, contract.offers);
  expectCount(errors, "Products with two or more sections", productsWithTwoOrMoreSections.length, contract.productsWithTwoOrMoreSections);
  expectCount(errors, "Additional section count", additionalSections.length, contract.additionalSections);
  expectUnique(errors, "SKUs", variants.map((variant) => variant.sku));
  expectUnique(errors, "Variant logical keys", variants.map((variant) => variant.logicalKey));
  expectUnique(errors, "Media logical keys", allMedia.map((media) => media.logicalKey));
  expectUnique(errors, "Media alt text", allMedia.map((media) => media.altText));
  expectUnique(errors, "Collection logical keys", manifest.collections.map((collection) => collection.logicalKey));

  const retained = new Map(manifest.products.filter((product) => product.retainedProductId).map((product) => [product.slug, product.retainedProductId]));
  if (retained.get("rider-court-trainers") !== "prod_9XNNERD2XpAOIoI1SN6gx") errors.push("Rider retained product identity changed");
  if (retained.get("halo-arc-table-lamp") !== "prod_FOHvuxr0Hr11AA_hyLUpH") errors.push("Halo retained product identity changed");

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      categories: manifest.categories.length,
      products: manifest.products.length,
      skus: variants.length,
      optionedProducts: optionedProducts.length,
      simpleProducts: simpleProducts.length,
      productMediaSlots: productMedia.length,
      presentationMediaSlots: presentationMedia.length,
      mediaSlots: allMedia.length,
      productsWithTwoOrMoreSections: productsWithTwoOrMoreSections.length,
      additionalSections: additionalSections.length,
      collections: manifest.collections.length,
      offers: offers.length,
      heroes: manifest.heroes.length,
    },
  };
}

export function assertValidDemoStoreManifest(manifest = demoStoreManifest) {
  const result = validateDemoStoreManifest(manifest);
  if (!result.ok) {
    const error = new Error(`Demo store manifest is invalid:\n- ${result.errors.join("\n- ")}`);
    error.name = "DemoStoreManifestError";
    throw error;
  }
  return result.summary;
}
