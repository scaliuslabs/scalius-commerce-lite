import { createApplyBinder } from "./apply-bind.mjs";
import { createApplyClient } from "./apply-client.mjs";
import { executeIdempotentCommand } from "./apply-executor.mjs";
import { assertStagedAssetReadiness } from "./apply-readiness.mjs";
import { createApplyRuntime } from "./apply-runtime.mjs";
import { createAdminReadClient, readAdminSnapshot } from "./api-read.mjs";
import { buildDemoStoreDiff } from "./diff.mjs";
import { writeEvidenceBundle } from "./evidence.mjs";
import { closeAdminSession, openAdminSession } from "./session.mjs";
import { demoApplyIntentFingerprint } from "./apply/authorization.mjs";
import { runDemoApplyLifecycle } from "./apply/orchestrator.mjs";
import { buildDemoApplyLifecycle } from "./apply/phase-model.mjs";
import { assertApplyExclusions, assertApplyPermissions } from "./apply/preflight.mjs";
import { appendPrivateResumeRecord, readPrivateResumeRecords, writePrivateApplyEvidence } from "./apply/private-state.mjs";
import { assertRetainedProductAuthority } from "./apply/retained-authority.mjs";
import {
  assertCompleteRemoteMediaReadiness,
  assertFreshApplySnapshot,
  snapshotAuthorityFingerprint,
  verifyDemoApplyDesiredState,
} from "./apply/verification.mjs";
import { compileDemoStoreAdminCommands } from "./compile.mjs";

export { assertRetainedProductAuthority } from "./apply/retained-authority.mjs";

const STAGED_PHASES = ["vocabulary", "categories", "products", "collections", "presentation"];

function exactMap(rows, field, label) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (result.has(row[field])) throw new Error(`${label} exact identity is ambiguous: ${row[field]}`);
    result.set(row[field], row);
  }
  return result;
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

function assertLifecycleReady(lifecycle) {
  const blocked = lifecycle.phases.filter((phase) => phase.state === "blocked");
  if (blocked.length) {
    throw new Error(`Demo apply lifecycle is blocked: ${blocked.flatMap((phase) => phase.blockers.map((blocker) => `${phase.name}:${blocker.code}`)).join(", ")}.`);
  }
}

function assertDiffHasNoConflicts(diff) {
  if (diff.summary.conflicts > 0) throw new Error("Fresh demo-store diff contains identity conflicts; no writes were authorized.");
}

export async function runDemoStoreApply({
  adminOrigin,
  credentials,
  readinessReport,
  evidenceDir,
  resumeFile,
  manifest,
  publicationIntent = {},
  timeoutMs = 20_000,
  fetchImpl = fetch,
  confirmApply,
  now = () => new Date(),
  openSession = openAdminSession,
  closeSession = closeAdminSession,
  readClientFactory = createAdminReadClient,
  applyClientFactory = createApplyClient,
  snapshotReader = readAdminSnapshot,
  diffBuilder = buildDemoStoreDiff,
  evidenceWriter = writeEvidenceBundle,
  lifecycleRunner = runDemoApplyLifecycle,
  desiredStateVerifier = verifyDemoApplyDesiredState,
}) {
  if (typeof confirmApply !== "function") throw new Error("Demo apply requires an interactive reset and fingerprint confirmation reader.");
  assertApplyExclusions({ publicationIntent, readinessReport });
  assertStagedAssetReadiness(manifest, readinessReport);
  const intentFingerprint = demoApplyIntentFingerprint(manifest, publicationIntent);
  let session;
  let cleanup = { status: "not_started", statusCode: null };
  try {
    session = await openSession({ adminOrigin, ...credentials, fetchImpl, timeoutMs });
    const readClient = readClientFactory({ adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs });

    const previewSnapshot = await snapshotReader(readClient, manifest);
    assertFreshApplySnapshot(previewSnapshot, now());
    const readiness = assertCompleteRemoteMediaReadiness(manifest, readinessReport, previewSnapshot);
    assertRetainedProductAuthority(manifest, previewSnapshot, readiness);
    const previewDiff = diffBuilder(manifest, previewSnapshot);
    assertDiffHasNoConflicts(previewDiff);
    const previewCompiled = compileDemoStoreAdminCommands(manifest, { current: previewSnapshot });
    const previewLifecycle = buildDemoApplyLifecycle({
      manifest, snapshot: previewSnapshot, compiled: previewCompiled, publicationIntent,
    });
    assertLifecycleReady(previewLifecycle);
    const previewPermissionContext = await readClient.get("/api/v1/admin/rbac/my-permissions", "Demo apply permission preflight");
    const previewPermissions = assertApplyPermissions(previewPermissionContext, previewLifecycle);

    const authorization = await confirmApply({
      intentFingerprint,
      diff: previewDiff,
      lifecycle: previewLifecycle,
      permissions: previewPermissions,
    });
    if (authorization?.resetConfirmed !== true || authorization?.confirmed !== true
      || authorization.intentFingerprint !== intentFingerprint) {
      throw new Error("Demo reset and intent fingerprint confirmation did not authorize this apply.");
    }

    const snapshot = await snapshotReader(readClient, manifest);
    assertFreshApplySnapshot(snapshot, now());
    if (snapshotAuthorityFingerprint(snapshot) !== snapshotAuthorityFingerprint(previewSnapshot)) {
      throw new Error("Admin state changed during confirmation; restart demo apply from a fresh diff.");
    }
    const freshReadiness = assertCompleteRemoteMediaReadiness(manifest, readinessReport, snapshot);
    assertRetainedProductAuthority(manifest, snapshot, freshReadiness);
    const diff = diffBuilder(manifest, snapshot);
    assertDiffHasNoConflicts(diff);
    const compiled = compileDemoStoreAdminCommands(manifest, { current: snapshot });
    const lifecycle = buildDemoApplyLifecycle({ manifest, snapshot, compiled, publicationIntent });
    assertLifecycleReady(lifecycle);
    const permissionContext = await readClient.get("/api/v1/admin/rbac/my-permissions", "Final demo apply permission preflight");
    const permissions = assertApplyPermissions(permissionContext, lifecycle);
    const evidence = await evidenceWriter({ baseDir: evidenceDir, snapshot, diff });
    const resumeRecords = await readPrivateResumeRecords(resumeFile);
    const client = applyClientFactory({ adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs });
    const runtime = createApplyRuntime(readClient);

    const result = await lifecycleRunner({
      manifest,
      publicationIntent,
      authorization,
      lifecycle,
      resumeRecords,
      bindCommand: (intent, { outputs }) => createApplyBinder({
        manifest, readiness: freshReadiness, snapshot, outputs,
      }).bind(intent),
      executeCommand: (command) => executeIdempotentCommand(command, {
        client,
        resolveCurrent: runtime.resolveCurrent,
        matchesDesired: runtime.matchesDesired,
      }),
      recordResume: (record) => appendPrivateResumeRecord(resumeFile, record),
      now,
    });

    const finalSnapshot = await snapshotReader(readClient, manifest);
    const verification = await desiredStateVerifier({
      manifest,
      readinessReport,
      lifecycle,
      snapshot: finalSnapshot,
      outputs: result.authorities,
      readClient,
      now: now(),
    });
    const applyEvidence = await writePrivateApplyEvidence(evidence.runDir, {
      schemaVersion: 1,
      mode: "apply",
      status: "verified",
      intentFingerprint,
      beforeSnapshotFingerprint: snapshotAuthorityFingerprint(snapshot),
      afterSnapshotFingerprint: snapshotAuthorityFingerprint(finalSnapshot),
      requiredPermissions: permissions.required,
      phases: result.phases.map((phase) => ({
        name: phase.name,
        state: phase.state,
        outcomes: phase.outcomes.map((outcome) => ({ logicalKey: outcome.logicalKey, status: outcome.status })),
      })),
      desiredState: {
        status: verification.status,
        verifiedCommands: verification.verifiedCommands,
        diffSummary: verification.diff.summary,
      },
      excludedWrites: ["header", "footer", "standalone_promotions"],
      completedAt: now().toISOString(),
    });
    return {
      mode: "apply",
      status: "verified",
      writesEnabled: true,
      intentFingerprint,
      permissions,
      phases: result.phases,
      verification: { status: verification.status, verifiedCommands: verification.verifiedCommands, diff: verification.diff },
      evidence: { runId: evidence.runId, runDir: evidence.runDir, apply: applyEvidence },
      resumeFile,
      get sessionCleanup() { return cleanup; },
    };
  } finally {
    if (session?.cookieHeader) cleanup = await closeSession({
      adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs,
    });
  }
}
