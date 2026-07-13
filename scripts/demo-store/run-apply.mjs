import { createApplyBinder } from "./apply-bind.mjs";
import { assertStagedAssetReadiness } from "./apply-readiness.mjs";
import { demoApplyIntentFingerprint } from "./apply/authorization.mjs";
import { compileDemoStoreAdminCommands } from "./compile.mjs";

const STAGED_PHASES = ["vocabulary", "categories", "products", "collections", "presentation"];

function exactMap(rows, field, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (result.has(row[field])) throw new Error(`${label} exact identity is ambiguous: ${row[field]}`);
    result.set(row[field], row);
  }
  return result;
}

function combinationKeys(product) {
  return product.variants.map((variant) => variant.optionValues.join("\u001f")).sort();
}

function currentCombinationKeys(detail) {
  return (detail.variants ?? [])
    .map((variant) => (variant.selectedOptions ?? []).slice().sort((a, b) => a.position - b.position).map((item) => item.value).join("\u001f"))
    .sort();
}

export function assertRetainedProductAuthority(manifest, snapshot, readiness) {
  const details = exactMap(snapshot.productDetails, "slug", "Product details");
  for (const product of manifest.products.filter((item) => item.retainedProductId)) {
    const detail = details.get(product.slug);
    if (!detail || detail.id !== product.retainedProductId) throw new Error(`Retained product identity is missing or changed for ${product.slug}.`);
    const intendedAxes = product.options.map((option) => option.name);
    const currentAxes = (detail.options ?? []).slice().sort((a, b) => a.position - b.position).map((option) => option.name);
    if (JSON.stringify(intendedAxes) !== JSON.stringify(currentAxes)) throw new Error(`Retained option axes changed for ${product.slug}.`);
    if (JSON.stringify(combinationKeys(product)) !== JSON.stringify(currentCombinationKeys(detail))) throw new Error(`Retained option topology changed for ${product.slug}.`);
    for (const variant of detail.variants ?? []) {
      if (![variant.stock, variant.reservedStock, variant.stockVersion].every(Number.isSafeInteger)) throw new Error(`Retained stock authority is incomplete for ${product.slug}.`);
    }
    const stagedIds = new Set(product.media.filter((item) => item.role !== "poster").map((item) => readiness.assets.get(item.logicalKey)?.mediaId));
    if ((detail.media ?? []).some((item) => item.status === "ready" && !stagedIds.has(item.mediaId))) throw new Error(`Retained media would be removed for ${product.slug}.`);
  }
}

function assertFreshSnapshot(snapshot, now, maxAgeMs = 5 * 60_000) {
  const captured = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(captured) || now.getTime() - captured > maxAgeMs || captured > now.getTime() + 30_000) throw new Error("Apply requires a fresh authenticated snapshot.");
}

function assertUnversionedSettingsExcluded(intent) {
  if (intent?.header || intent?.footer) throw new Error("Header/footer writes are not revisioned and remain blocked from automated apply.");
}

function assertStagedResourcesInactive(manifest, snapshot) {
  const retainedIds = new Set(manifest.products
    .map((product) => product.retainedProductId)
    .filter(Boolean));
  const activeProduct = (snapshot.productDetails ?? []).find((product) =>
    product.isActive === true && !retainedIds.has(product.id),
  );
  if (activeProduct) {
    throw new Error(`Inactive staging requires ${activeProduct.slug} to be quarantined before apply.`);
  }
  const activeCollection = (snapshot.collections ?? []).find((collection) => collection.isActive === true);
  if (activeCollection) {
    throw new Error(`Inactive staging requires collection ${activeCollection.name} to be quarantined before apply.`);
  }
  const activeHero = (snapshot.presentation?.heroes ?? snapshot.heroes ?? []).find((hero) => hero.isActive === true);
  if (activeHero) {
    throw new Error(`Inactive staging requires the ${activeHero.type} hero to be quarantined before apply.`);
  }
}

function simpleResumeSlugs(manifest, snapshot, completed) {
  const details = exactMap(snapshot.productDetails, "slug", "Product details");
  const resumable = [];
  for (const product of manifest.products.filter((item) => item.options.length === 0 && !item.retainedProductId)) {
    const detail = details.get(product.slug);
    if (!detail) continue;
    const variants = (detail.variants ?? []).filter((variant) => !variant.deletedAt);
    if (variants.length !== 1 || variants[0].isDefault !== true) throw new Error(`Simple product ${product.slug} does not have exactly one default SKU.`);
    const desiredStock = product.variants[0].inventory.onHand;
    if (variants[0].stock === desiredStock) continue;
    const baseComplete = completed.has(`${product.logicalKey}:base`) || completed.has(product.logicalKey);
    const stockComplete = completed.has(`${product.logicalKey}:simple-sku`) || completed.has(`${product.logicalKey}:initial-stock`);
    if (!baseComplete || stockComplete) throw new Error(`Simple stock provenance is unknown for ${product.slug}; refusing to reset inventory.`);
    resumable.push(product.slug);
  }
  return resumable;
}

export async function runRevisionSafeApply({
  manifest,
  readinessReport,
  authorization,
  readSnapshot,
  executeCommand,
  recordOutcome = async () => undefined,
  now = () => new Date(),
}) {
  const readiness = assertStagedAssetReadiness(manifest, readinessReport);
  if (authorization?.confirmed !== true
    || authorization.intentFingerprint !== demoApplyIntentFingerprint(manifest)) {
    throw new Error("Apply authorization does not match the complete validated demo-store intent.");
  }
  if (typeof executeCommand !== "function") throw new Error("Apply requires an authenticated command executor.");
  assertUnversionedSettingsExcluded(readinessReport.presentation);

  const completed = new Set(authorization.completedResumeKeys ?? []);
  let snapshot = await readSnapshot();
  assertFreshSnapshot(snapshot, now());
  assertRetainedProductAuthority(manifest, snapshot, readiness);
  assertStagedResourcesInactive(manifest, snapshot);
  const resumeSimpleSlugs = simpleResumeSlugs(manifest, snapshot, completed);
  const compiled = compileDemoStoreAdminCommands(manifest, { current: { ...snapshot, resumeSimpleSlugs } });
  const outputs = new Map();
  const phases = [];

  for (let phaseIndex = 0; phaseIndex < STAGED_PHASES.length; phaseIndex += 1) {
    const phase = STAGED_PHASES[phaseIndex];
    if (phaseIndex > 0) snapshot = await readSnapshot();
    assertFreshSnapshot(snapshot, now());
    assertRetainedProductAuthority(manifest, snapshot, readiness);
    assertStagedResourcesInactive(manifest, snapshot);
    const binder = createApplyBinder({ manifest, readiness, snapshot, outputs });
    const commands = compiled.commands.filter((command) => command.phase === phase);
    const outcomes = [];
    for (const intent of commands) {
      const bound = binder.bind(intent);
      const outcome = await executeCommand(bound, { phase });
      outcomes.push(outcome);
      await recordOutcome(phase, outcome);
      if (outcome.authority) outputs.set(intent.logicalKey, outcome.authority);
      else if (outcome.resourceId) outputs.set(intent.logicalKey, { id: outcome.resourceId });
      if (outcome.status === "conflict") {
        phases.push({ name: phase, ok: false, outcomes });
        throw new Error(`Apply stopped after a conflict in ${phase}.`);
      }
    }
    phases.push({ name: phase, ok: true, outcomes });
  }

  return {
    status: "staged_complete",
    writesEnabled: true,
    compiledSummary: compiled.summary,
    excludedPhases: ["activation", "publication"],
    phases,
  };
}
