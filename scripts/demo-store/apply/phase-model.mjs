import { demoThemeBlocker } from "../theme-homepage.mjs";

const API = "/api/v1/admin";

export const DEMO_APPLY_PHASE_ORDER = Object.freeze([
  "quarantine",
  "stage_vocabulary",
  "stage_categories",
  "stage_products",
  "stage_collections",
  "stage_theme",
  "activate_products",
  "publish_categories",
  "activate_collections",
  "activate_promotions",
  "publish_navigation",
  "publish_theme",
]);

function reference(logicalKey, field = "id") {
  return { $ref: logicalKey, field };
}

function cloneCommand(command, changes) {
  return {
    ...command,
    ...changes,
    body: changes.body ?? command.body,
    dependsOn: changes.dependsOn ?? command.dependsOn ?? [],
  };
}

function phaseRecord(name) {
  return { name, state: "ready", commands: [], blockers: [] };
}

function exactBy(rows, field, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (result.has(row[field])) throw new Error(`${label} identity is ambiguous: ${row[field]}`);
    result.set(row[field], row);
  }
  return result;
}

function findCommand(commands, logicalKey) {
  return commands.find((command) => command.logicalKey === logicalKey);
}

function lastProductStageKey(product, compiledCommands) {
  const matrix = findCommand(compiledCommands, `${product.logicalKey}:matrix`);
  const simple = findCommand(compiledCommands, `${product.logicalKey}:simple-sku`);
  return matrix?.logicalKey ?? simple?.logicalKey ?? `${product.logicalKey}:base`;
}

function productActivationCommand(product, base, finalStageKey) {
  const existingPath = !base.path.includes("{") && base.method === "PUT";
  const baseBody = { ...base.body };
  delete baseBody.optionMatrix;
  return {
    ...base,
    id: `${base.id}:activate`,
    logicalKey: `${product.logicalKey}:activate`,
    phase: "activate_products",
    method: "PUT",
    path: existingPath ? base.path : `${API}/products/{productId}`,
    ...(existingPath ? {} : { pathBindings: { productId: reference(base.logicalKey) } }),
    body: {
      ...baseBody,
      id: existingPath ? baseBody.id : reference(base.logicalKey),
      isActive: true,
      expectedAggregateRevision: reference(finalStageKey, "aggregateRevision"),
    },
    dependsOn: [finalStageKey],
    preconditions: { expectedAggregateRevision: reference(finalStageKey, "aggregateRevision") },
  };
}

function collectionActivationCommand(collection, stage, current) {
  const path = current?.id ? `${API}/collections/${current.id}` : `${API}/collections/{collectionId}`;
  return {
    id: `${stage.id}:activate`,
    logicalKey: `${collection.logicalKey}:activate`,
    phase: "activate_collections",
    method: "PUT",
    path,
    ...(current?.id ? {} : { pathBindings: { collectionId: reference(stage.logicalKey) } }),
    body: {
      expectedVersion: reference(stage.logicalKey, "version"),
      isActive: true,
    },
    dependsOn: [stage.logicalKey],
    preconditions: { expectedVersion: reference(stage.logicalKey, "version") },
  };
}

/** Publishes exactly the staged draft revision over the live revision read. */
function themePublishCommand(stage) {
  return {
    id: `${stage.id}:publish`,
    logicalKey: "theme:publish",
    phase: "publish_theme",
    method: "POST",
    path: `${API}/settings/theme/publish`,
    action: "update",
    body: {
      expectedPublishedRevision: reference("current-theme", "publishedRevision"),
      expectedDraftRevision: reference(stage.logicalKey, "revision"),
    },
    desired: stage.desired,
    dependsOn: [stage.logicalKey],
    preconditions: { expectedRevision: reference("current-theme", "publishedRevision") },
  };
}

function requireBlocked(phase, code, message) {
  phase.state = "blocked";
  phase.blockers.push({ code, message });
}

export function buildDemoApplyLifecycle({
  manifest,
  snapshot,
  compiled,
  publicationIntent = {},
}) {
  const phases = new Map(DEMO_APPLY_PHASE_ORDER.map((name) => [name, phaseRecord(name)]));
  const currentProducts = exactBy(snapshot.productDetails, "slug", "Product");
  const currentCollections = exactBy(snapshot.collections, "name", "Collection");

  for (const command of compiled.commands.filter((item) => item.phase === "vocabulary")) {
    phases.get("stage_vocabulary").commands.push(cloneCommand(command, { phase: "stage_vocabulary" }));
  }

  for (const command of compiled.commands.filter((item) => item.phase === "categories")) {
    phases.get("stage_categories").commands.push(cloneCommand(command, { phase: "stage_categories" }));
  }

  for (const product of manifest.products) {
    const base = findCommand(compiled.commands, `${product.logicalKey}:base`);
    if (!base) throw new Error(`Product base command is missing for ${product.slug}.`);
    const current = currentProducts.get(product.slug);
    const retained = Boolean(product.retainedProductId);
    const inactiveBase = retained ? base : cloneCommand(base, { body: { ...base.body, isActive: false } });
    if (!retained && current?.isActive === true) {
      phases.get("quarantine").commands.push(cloneCommand(inactiveBase, { phase: "quarantine" }));
    } else {
      phases.get("stage_products").commands.push(cloneCommand(inactiveBase, { phase: "stage_products" }));
    }
    for (const suffix of ["matrix", "simple-sku"]) {
      const stage = findCommand(compiled.commands, `${product.logicalKey}:${suffix}`);
      if (stage) phases.get("stage_products").commands.push(cloneCommand(stage, { phase: "stage_products" }));
    }
    if (!retained) {
      const finalStageKey = lastProductStageKey(product, compiled.commands);
      phases.get("activate_products").commands.push(productActivationCommand(product, inactiveBase, finalStageKey));
    }
  }

  for (const command of compiled.commands.filter((item) => item.phase === "publication")) {
    const slug = command.logicalKey.slice("category:".length).replace(/:publish$/u, "");
    const productDependencies = manifest.products
      .filter((product) => product.categorySlug === slug)
      .map((product) => product.retainedProductId ? `${product.logicalKey}:base` : `${product.logicalKey}:activate`);
    phases.get("publish_categories").commands.push(cloneCommand(command, {
      phase: "publish_categories",
      dependsOn: [command.logicalKey.replace(/:publish$/u, ""), ...productDependencies],
    }));
  }

  for (const collection of manifest.collections) {
    const command = findCommand(compiled.commands, collection.logicalKey);
    if (!command) throw new Error(`Collection command is missing for ${collection.name}.`);
    const current = currentCollections.get(collection.name);
    let stage = cloneCommand(command, {
      phase: "stage_collections",
      body: { ...command.body, isActive: false },
    });
    if (current?.isActive === true) {
      const quarantineKey = `${collection.logicalKey}:quarantine`;
      phases.get("quarantine").commands.push({
        id: `${command.id}:quarantine`, logicalKey: quarantineKey, phase: "quarantine",
        method: "PUT", path: `${API}/collections/${current.id}`,
        body: { expectedVersion: current.version, isActive: false },
        preconditions: { expectedVersion: current.version }, dependsOn: [],
      });
      stage = cloneCommand(stage, {
        body: { ...stage.body, expectedVersion: reference(quarantineKey, "version") },
        preconditions: { expectedVersion: reference(quarantineKey, "version") },
        dependsOn: [quarantineKey, ...(stage.dependsOn ?? [])],
      });
    }
    phases.get("stage_collections").commands.push(stage);
    phases.get("activate_collections").commands.push(collectionActivationCommand(collection, stage, current));
  }

  // The homepage lives in the storefront theme. A saved draft is not public,
  // so staging needs no quarantine: the draft is saved after the catalog is
  // staged and published last, once every slide destination and homepage
  // collection resolves publicly. A draft with the merchant's unpublished
  // changes blocks the whole apply before any write.
  const themeDraft = findCommand(compiled.commands, "theme:draft");
  if (!themeDraft) throw new Error("Theme draft command is missing.");
  const themeBlocker = demoThemeBlocker(snapshot.presentation?.theme);
  if (themeBlocker) {
    requireBlocked(phases.get("stage_theme"), themeBlocker.code, themeBlocker.message);
    requireBlocked(phases.get("publish_theme"), themeBlocker.code, themeBlocker.message);
  } else {
    const stage = cloneCommand(themeDraft, { phase: "stage_theme" });
    phases.get("stage_theme").commands.push(stage);
    phases.get("publish_theme").commands.push(themePublishCommand(stage));
  }

  if (publicationIntent.promotions?.length) {
    requireBlocked(
      phases.get("activate_promotions"),
      "PROMOTION_CAS_MISSING",
      "Standalone discounts do not have a monotonic revision contract and cannot be automated safely.",
    );
  } else {
    phases.get("activate_promotions").state = "skipped";
  }

  if (publicationIntent.navigation?.header || publicationIntent.navigation?.footer) {
    requireBlocked(
      phases.get("publish_navigation"),
      "NAVIGATION_CAS_MISSING",
      "Header and footer are unversioned whole-document settings and remain excluded from automated apply.",
    );
  } else {
    phases.get("publish_navigation").state = "skipped";
  }

  return {
    schemaVersion: 1,
    phases: DEMO_APPLY_PHASE_ORDER.map((name) => phases.get(name)),
    hasBlockers: [...phases.values()].some((phase) => phase.state === "blocked"),
  };
}
