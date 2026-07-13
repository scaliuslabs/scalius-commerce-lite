import { assertStagedAssetReadiness, manifestReadinessFingerprint } from "./apply-readiness.mjs";
import {
  assertUnversionedSettingsExcluded,
  buildCategoryCommand,
  buildCollectionCommand,
  buildHeroCommands,
  buildProductCommands,
  buildSimpleStockInitializationCommand,
  buildThemeCommand,
} from "./apply-commands.mjs";

function exactMap(rows, field, label) {
  const result = new Map();
  for (const row of rows) {
    if (result.has(row[field])) throw new Error(`${label} exact identity is ambiguous: ${row[field]}`);
    result.set(row[field], row);
  }
  return result;
}

function combinationKeys(product) {
  return product.variants.map((variant) => variant.optionValues.join("\u001f")).sort();
}

function currentCombinationKeys(detail) {
  return detail.variants.map((variant) => (variant.selectedOptions ?? []).slice().sort((a, b) => a.position - b.position).map((item) => item.value).join("\u001f")).sort();
}

export function assertRetainedProductAuthority(manifest, snapshot, readiness) {
  const details = exactMap(snapshot.productDetails, "slug", "Product details");
  for (const product of manifest.products.filter((item) => item.retainedProductId)) {
    const detail = details.get(product.slug);
    if (!detail || detail.id !== product.retainedProductId) throw new Error(`Retained product identity is missing or changed for ${product.slug}.`);
    if (JSON.stringify(combinationKeys(product)) !== JSON.stringify(currentCombinationKeys(detail))) throw new Error(`Retained option topology changed for ${product.slug}.`);
    for (const variant of detail.variants) {
      if (![variant.stock, variant.reservedStock, variant.stockVersion].every(Number.isSafeInteger)) throw new Error(`Retained stock authority is incomplete for ${product.slug}.`);
    }
    const stagedIds = new Set(product.media.filter((item) => item.role !== "poster").map((item) => readiness.assets.get(item.logicalKey)?.mediaId));
    if (detail.media.some((item) => item.status === "ready" && !stagedIds.has(item.mediaId))) throw new Error(`Retained media would be removed for ${product.slug}.`);
  }
}

function assertFreshSnapshot(snapshot, now, maxAgeMs = 5 * 60_000) {
  const captured = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(captured) || now.getTime() - captured > maxAgeMs || captured > now.getTime() + 30_000) throw new Error("Apply requires a fresh authenticated snapshot.");
}

export async function runRevisionSafeApply({
  manifest,
  readinessReport,
  authorization,
  readSnapshot,
  executePhase,
  recordOutcome = async () => undefined,
  now = () => new Date(),
}) {
  const readiness = assertStagedAssetReadiness(manifest, readinessReport);
  if (authorization?.confirmed !== true || authorization.manifestFingerprint !== manifestReadinessFingerprint(manifest)) {
    throw new Error("Apply authorization does not match the validated manifest.");
  }
  assertUnversionedSettingsExcluded(readinessReport.presentation);
  const completed = new Set(authorization.completedResumeKeys ?? []);
  const phases = [];

  const run = async (name, commands) => {
    const result = await executePhase(commands, { phase: name });
    for (const outcome of result.outcomes) await recordOutcome(name, outcome);
    phases.push({ name, ...result });
    if (!result.ok) throw new Error(`Apply stopped after a conflict in ${name}.`);
    return result;
  };

  let snapshot = await readSnapshot();
  assertFreshSnapshot(snapshot, now());
  assertRetainedProductAuthority(manifest, snapshot, readiness);
  const categories = exactMap(snapshot.categories, "slug", "Categories");
  await run("categories", manifest.categories.map((item) => buildCategoryCommand(item, categories.get(item.slug), readiness)));

  snapshot = await readSnapshot();
  assertFreshSnapshot(snapshot, now());
  const categoryIds = new Map(snapshot.categories.map((item) => [item.slug, item.id]));
  const products = exactMap(snapshot.products, "slug", "Products");
  const details = exactMap(snapshot.productDetails, "slug", "Product details");
  const brand = snapshot.attributes.find((item) => item.slug === "brand" && item.filterable === true);
  if (!brand) throw new Error("The filterable Brand attribute must exist before product apply.");
  const productCommands = manifest.products.flatMap((item) => buildProductCommands(item, products.get(item.slug), details.get(item.slug), { readiness, categoryId: categoryIds.get(item.categorySlug), brandAttributeId: brand.id }));
  const productResult = await run("products", productCommands);

  snapshot = await readSnapshot();
  assertFreshSnapshot(snapshot, now());
  const postDetails = exactMap(snapshot.productDetails, "slug", "Product details");
  const newlyCreated = new Set(productResult.outcomes.filter((item) => ["applied", "adopted_after_ambiguous_response"].includes(item.status)).map((item) => item.logicalKey));
  const simpleStockCommands = manifest.products.filter((item) => !item.options.length && !item.retainedProductId).flatMap((item) => {
    const resumeKey = `${item.logicalKey}:initial-stock`;
    const mayInitialize = newlyCreated.has(item.logicalKey) || (completed.has(item.logicalKey) && !completed.has(resumeKey));
    if (!mayInitialize) {
      const detail = postDetails.get(item.slug);
      const current = detail?.variants?.[0];
      if (current?.stock !== item.variants[0].inventory.onHand) throw new Error(`Simple stock provenance is unknown for ${item.slug}; refusing to reset inventory.`);
      return [];
    }
    return [buildSimpleStockInitializationCommand(item, postDetails.get(item.slug))];
  });
  if (simpleStockCommands.length) await run("product-stock-initialization", simpleStockCommands);

  snapshot = await readSnapshot();
  assertFreshSnapshot(snapshot, now());
  const productIds = new Map(snapshot.products.map((item) => [item.slug, item.id]));
  const collections = exactMap(snapshot.collections, "name", "Collections");
  await run("collections", manifest.collections.map((item) => buildCollectionCommand(item, collections.get(item.name), {
    categoryIds: new Map(snapshot.categories.map((category) => [category.slug, category.id])),
    productIds,
    offerSlugs: manifest.products.filter((product) => product.offer).map((product) => product.slug),
    newNoteworthySlugs: manifest.categories.flatMap((category, index) => manifest.products
      .filter((product) => product.categorySlug === category.slug)
      .slice(0, index < 2 ? 3 : 2)
      .map((product) => product.slug)),
  })));

  snapshot = await readSnapshot();
  assertFreshSnapshot(snapshot, now());
  const collectionIds = new Map(snapshot.collections.map((item) => [item.name, item.id]));
  const resolveDestination = (destination) => {
    if (destination.startsWith("category:")) return `/categories/${destination.slice("category:".length)}`;
    if (destination === "collection:new-noteworthy") return `/collections/${collectionIds.get("New & Noteworthy")}`;
    throw new Error(`Hero destination is unresolved: ${destination}`);
  };
  const settings = [
    buildThemeCommand(readinessReport.presentation?.theme, snapshot.presentation.theme),
    ...buildHeroCommands(manifest, snapshot.presentation.heroes, readiness, resolveDestination),
  ].filter(Boolean);
  await run("settings", settings);
  return { status: "staged_complete", writesEnabled: true, phases };
}
