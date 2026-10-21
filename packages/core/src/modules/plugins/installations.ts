// Plugin installations (docs/platform/PLUGINS.md, P1): install, approve and
// activate, turn features on and off, deactivate, update, uninstall, and the
// merchant's settings. Every write is a compare-and-set on `revision`; the
// extension-point registrations are rewritten in the same batch as the
// manifest or grant they derive from.
//
// Features (`manifest.features`): the approved grant records which are on.
// An installation is read through `pluginManifestWithFeatures`, so
// `installation.manifest` is the app as it runs (off features removed) and
// every runtime reader gates on it; `declaredManifest` keeps the whole
// declaration for the dashboard, updates and the load check.

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import {
  pluginEventDeliveries,
  pluginInstallations,
  webhookSubscriptions,
  bulkRuns,
  pluginMigrations,
  pluginRegistrations,
  salesChannels,
  type PluginInstallationRow,
  type PluginInstallationSource,
  type PluginInstallationStatus,
} from "@scalius/database/schema";
import { looksLikePlaceholderCredential } from "@scalius/shared/plugins/placeholder-credentials";
import { currentProviderKind } from "@scalius/shared/plugins/providers/kinds";
import {
  PLUGIN_EXTENSION_RUN,
  FIRST_PARTY_PLUGIN_VENDOR,
  isPluginScope,
  knownPluginFeatures,
  legacyPermissionScope,
  parsePluginManifest,
  pluginCompatibility,
  pluginGrantExpands,
  pluginGrantKey,
  pluginGrantRequest,
  pluginFeatureOwners,
  pluginManifestWithFeatures,
  pluginSettingDefaults,
  validatePluginSettingValues,
  type PluginGrantRequest,
  type PluginManifest,
  type PluginSettingField,
  type PluginSettingValue,
  type PluginSettingValues,
} from "@scalius/shared/plugins";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { appSalesChannelId } from "@scalius/shared/sales-channels";
import { PluginError } from "./errors";
import { appJobRowsCondition } from "./app-jobs";
import { releaseHeldPluginDeliveriesStatement } from "./held-deliveries";
import {
  appDataDeleteStatements,
  forgetRetainedAppStatement,
  readRetainedApp,
  retainAppStatement,
  type RetainedApp,
} from "./app-data";
import {
  derivePluginSettingsKey,
  isSealedPluginSecret,
  openPluginSecret,
  sealPluginSecret,
} from "./settings-crypto";
import { syncAppObjectTypes } from "../objects";

export interface PluginInstallation {
  pluginId: string;
  version: string;
  source: PluginInstallationSource;
  bundleSha256: string;
  /**
   * The manifest as the app runs: the base plus the features that are on
   * (`pluginManifestWithFeatures`). Every runtime reader uses this one.
   */
  manifest: PluginManifest;
  /** The manifest as declared, every feature included (dashboard, updates, load check). */
  declaredManifest: PluginManifest;
  /** The features that are on (`grant.features`, declared ones only); none before approval. */
  features: string[];
  /** The approved grant; null until a Super Admin approves one. */
  grant: PluginGrantRequest | null;
  grantKey: string | null;
  status: PluginInstallationStatus;
  failureReason: string | null;
  /** Stored setting values: secret fields hold `ps1:` ciphertext. */
  storedSettings: Record<string, unknown>;
  revision: number;
  installedBy: string | null;
  activatedBy: string | null;
  installedAt: number;
  activatedAt: number | null;
  updatedAt: number;
  /** The newest data update that ran (`manifest.migrations`). */
  migratedVersion: number;
  /** The trusted key that verified the bundle (registry or signed upload); null for bundled code and unsigned uploads. */
  signerKeyId: string | null;
  /** Bytes in its storage and key/value data at the last measurement (null: not measured yet). */
  storageBytes: number;
  storageMeasuredAt: number | null;
}

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_FAILURE_REASON = 500;

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null;
}

/**
 * A stored grant, or null when absent or malformed (a malformed grant grants
 * nothing). A grant approved before scopes (RBAC `permissions`) is not
 * translated: scopes are not a one-to-one renaming, so the app waits for a
 * Super Admin to approve its scopes. One that granted no permissions grants
 * no scopes.
 */
export function parseStoredPluginGrant(value: string | null): PluginGrantRequest | null {
  const stored = parseJsonObject(value);
  if (!stored) return null;
  const { permissions: legacy, ...current } = stored;
  const raw = current.scopes === undefined && Array.isArray(legacy) && legacy.length === 0 ? { ...current, scopes: [] } : stored;
  const lists = ["scopes", "allowedHosts", "events", "functions", "blockingFunctions", "providers", "storefrontScripts", "customFieldOwners"] as const;
  const parsed: Partial<Record<(typeof lists)[number], string[]>> = {};
  for (const key of lists) {
    const list = stringList(raw[key]);
    if (!list) return null;
    parsed[key] = list;
  }
  if (!parsed.scopes!.every(isPluginScope)) return null;
  // A provider kind approved under an earlier name (`fraud`) stays approved under its current one.
  parsed.providers = [...new Set(parsed.providers!.map(currentProviderKind))];
  if (typeof raw.publicRoutes !== "boolean" || typeof raw.storefrontSurfaces !== "boolean") return null;
  // Dimensions added later read as their default when a stored grant predates them.
  if (raw.storefrontCode !== undefined && typeof raw.storefrontCode !== "boolean") return null;
  const connect = raw.storefrontConnect === undefined ? [] : stringList(raw.storefrontConnect);
  if (connect === null) return null;
  const features = raw.features === undefined ? [] : stringList(raw.features);
  if (features === null) return null;
  const messageRecipients = raw.messageRecipients === undefined ? [] : stringList(raw.messageRecipients);
  if (messageRecipients === null) return null;
  const extensions = raw.extensions === undefined ? [] : stringList(raw.extensions);
  if (extensions === null) return null;
  return {
    ...(parsed as Record<(typeof lists)[number], string[]>),
    publicRoutes: raw.publicRoutes,
    storefrontSurfaces: raw.storefrontSurfaces,
    storefrontCode: raw.storefrontCode === true,
    storefrontConnect: connect,
    features,
    messageRecipients,
    extensions,
  } as PluginGrantRequest;
}

/**
 * A stored manifest read in the current shape. Each step is pure and leaves a
 * current manifest as it is; only the stored row's read shape changes, and
 * its grant still needs approval (`parseStoredPluginGrant`).
 *
 * 1. Before scopes: each RBAC permission becomes the first scope that confers
 *    it (`legacyPermissionScope`), an admin route's `permission` its `scope`.
 * 2. Before storefront extensions: a `buyer.ui` function becomes one
 *    `storefront.extensions` entry per target, with the function's reads.
 * 3. Before admin nesting: top-level `timeline` and `settingsGroups` move to
 *    `admin.timeline` and `admin.settingsGroups`.
 */
export function upgradeStoredPluginManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  return nestAdminParts(buyerUiAsExtensions(permissionsAsScopes(manifest)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buyerUiAsExtensions(manifest: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(manifest.functions)) return manifest;
  const buyerUi = manifest.functions.find((fn) => isObject(fn) && fn.point === "buyer.ui");
  if (!isObject(buyerUi)) return manifest;
  const storefront = isObject(manifest.storefront) ? manifest.storefront : {};
  const targets = Array.isArray(buyerUi.targets) ? buyerUi.targets : [];
  const reads = Array.isArray(buyerUi.reads) ? buyerUi.reads : [];
  return {
    ...manifest,
    functions: manifest.functions.filter((fn) => fn !== buyerUi),
    storefront: { ...storefront, extensions: targets.map((target) => ({ target, reads })) },
  };
}

function nestAdminParts(manifest: Record<string, unknown>): Record<string, unknown> {
  if (manifest.timeline === undefined && manifest.settingsGroups === undefined) return manifest;
  const { timeline, settingsGroups, ...rest } = manifest;
  const admin = isObject(rest.admin) ? rest.admin : {};
  return {
    ...rest,
    admin: {
      ...admin,
      ...(timeline !== undefined ? { timeline } : {}),
      ...(settingsGroups !== undefined ? { settingsGroups } : {}),
    },
  };
}

function permissionsAsScopes(manifest: Record<string, unknown>): Record<string, unknown> {
  if (manifest.scopes !== undefined || !Array.isArray(manifest.permissions)) return manifest;
  const { permissions, ...rest } = manifest;
  const scopes = [...new Set((permissions as unknown[])
    .map((permission) => (typeof permission === "string" ? legacyPermissionScope(permission) : null))
    .filter((scope): scope is NonNullable<typeof scope> => scope !== null))];
  const routes = rest.routes;
  if (routes && typeof routes === "object" && Array.isArray((routes as { admin?: unknown }).admin)) {
    rest.routes = {
      ...routes,
      admin: ((routes as { admin: unknown[] }).admin).map((route) => {
        if (!route || typeof route !== "object" || typeof (route as { permission?: unknown }).permission !== "string") return route;
        const { permission, ...routeRest } = route as { permission: string };
        const scope = legacyPermissionScope(permission);
        return scope ? { ...routeRest, scope } : route;
      }),
    };
  }
  return { ...rest, scopes };
}

/** A row as the runtime reads it; a manifest that no longer parses yields null (the plugin cannot run). */
export function toPluginInstallation(row: PluginInstallationRow): PluginInstallation | null {
  const storedManifest = parseJsonObject(row.manifestJson);
  const manifestJson = storedManifest ? upgradeStoredPluginManifest(storedManifest) : null;
  const parsed = manifestJson ? parsePluginManifest(manifestJson) : null;
  if (!parsed?.ok || parsed.manifest.id !== row.pluginId) return null;
  const grant = parseStoredPluginGrant(row.grantJson);
  const features = knownPluginFeatures(parsed.manifest, grant?.features ?? []);
  return {
    pluginId: row.pluginId,
    version: row.version,
    source: row.source,
    bundleSha256: row.bundleSha256,
    manifest: pluginManifestWithFeatures(parsed.manifest, features),
    declaredManifest: parsed.manifest,
    features,
    grant,
    grantKey: row.grantKey,
    status: row.status,
    failureReason: row.failureReason,
    storedSettings: parseJsonObject(row.settingsJson) ?? {},
    revision: row.revision,
    installedBy: row.installedBy,
    activatedBy: row.activatedBy,
    installedAt: row.installedAt,
    activatedAt: row.activatedAt,
    updatedAt: row.updatedAt,
    migratedVersion: row.migratedVersion ?? 0,
    signerKeyId: row.signerKeyId ?? null,
    storageBytes: row.storageBytes ?? 0,
    storageMeasuredAt: row.storageMeasuredAt ?? null,
  };
}

export async function getPluginInstallation(db: Database, pluginId: string): Promise<PluginInstallation | null> {
  const row = await db.select().from(pluginInstallations).where(eq(pluginInstallations.pluginId, pluginId)).get();
  return row ? toPluginInstallation(row) : null;
}

export async function requirePluginInstallation(db: Database, pluginId: string): Promise<PluginInstallation> {
  const installation = await getPluginInstallation(db, pluginId);
  if (!installation) throw new PluginError("installation_not_found", `Plugin ${pluginId} is not installed.`);
  return installation;
}

export async function listPluginInstallations(db: Database): Promise<PluginInstallation[]> {
  return (await readPluginInstallations(db)).installations;
}

/**
 * An installation row whose stored manifest this release cannot read: the
 * app cannot run, so the runtime skips it, but it is never invisible. The
 * Apps page lists it as failed, and a bundled one is rewritten from the
 * deployed code on the next sync (`updatePluginInstallation` accepts it).
 */
export interface UnreadablePluginInstallation {
  pluginId: string;
  version: string;
  source: PluginInstallationSource;
  status: PluginInstallationStatus;
  failureReason: string | null;
  revision: number;
  /** The stored manifest's name when it has one (the dashboard's label). */
  name: string | null;
  installedAt: number;
  activatedAt: number | null;
  updatedAt: number;
}

function unreadableInstallation(row: PluginInstallationRow): UnreadablePluginInstallation {
  const stored = parseJsonObject(row.manifestJson);
  return {
    pluginId: row.pluginId,
    version: row.version,
    source: row.source,
    status: row.status,
    failureReason: row.failureReason,
    revision: row.revision,
    name: typeof stored?.name === "string" && stored.name.trim() ? stored.name.trim().slice(0, 80) : null,
    installedAt: row.installedAt,
    activatedAt: row.activatedAt,
    updatedAt: row.updatedAt,
  };
}

/** One installation row: readable, unreadable (its stored manifest no longer reads), or null when none. */
export async function readPluginInstallation(db: Database, pluginId: string): Promise<
  { readable: true; installation: PluginInstallation } | { readable: false; installation: UnreadablePluginInstallation } | null
> {
  const row = await db.select().from(pluginInstallations).where(eq(pluginInstallations.pluginId, pluginId)).get();
  if (!row) return null;
  const installation = toPluginInstallation(row);
  return installation ? { readable: true, installation } : { readable: false, installation: unreadableInstallation(row) };
}

/** Every installation, in id order: those the runtime reads, and those whose stored manifest it cannot. */
export async function readPluginInstallations(db: Database): Promise<{
  installations: PluginInstallation[];
  unreadable: UnreadablePluginInstallation[];
}> {
  const rows = await db.select().from(pluginInstallations).orderBy(asc(pluginInstallations.pluginId)).all();
  const installations: PluginInstallation[] = [];
  const unreadable: UnreadablePluginInstallation[] = [];
  for (const row of rows) {
    const installation = toPluginInstallation(row);
    if (installation) installations.push(installation);
    else unreadable.push(unreadableInstallation(row));
  }
  return { installations, unreadable };
}

/**
 * What an update replaces. A row whose stored manifest no longer reads is
 * replaced too (its grant and settings still read on their own): the old
 * declarations are reconciled from the new manifest, along with its sales channels.
 */
interface InstallationBeforeUpdate {
  status: PluginInstallationStatus;
  grant: PluginGrantRequest | null;
  activatedBy: string | null;
  features: string[];
  storedSettings: Record<string, unknown>;
  /** The stored manifest as it runs; null when it no longer reads. */
  manifest: PluginManifest | null;
  /** The developer key the app was installed with (`requirePinnedSigner`). */
  signerKeyId: string | null;
}

async function installationBeforeUpdate(db: Database, pluginId: string): Promise<InstallationBeforeUpdate> {
  const row = await db.select().from(pluginInstallations).where(eq(pluginInstallations.pluginId, pluginId)).get();
  if (!row) throw new PluginError("installation_not_found", `Plugin ${pluginId} is not installed.`);
  const installation = toPluginInstallation(row);
  if (installation) return installation;
  const grant = parseStoredPluginGrant(row.grantJson);
  return {
    status: row.status,
    grant,
    activatedBy: row.activatedBy,
    features: grant?.features ?? [],
    storedSettings: parseJsonObject(row.settingsJson) ?? {},
    manifest: null,
    signerKeyId: row.signerKeyId ?? null,
  };
}

// ── Manifest checks beyond the schema ────────────────────────────────────

/** A manifest the store can install: parsed, known permissions only, nothing reserved. */
export function requireInstallableManifest(value: unknown, source: PluginInstallationSource): PluginManifest {
  // The plugin API version and the platform release first: a clear "needs a
  // newer Scalius" instead of a schema error.
  const compatible = pluginCompatibility(value);
  if (!compatible.ok) throw new PluginError("installation_incompatible", compatible.message, { reason: compatible.reason });
  const parsed = parsePluginManifest(value);
  if (!parsed.ok) {
    throw new PluginError("manifest_invalid", `The plugin manifest is invalid: ${parsed.issues[0]?.path} ${parsed.issues[0]?.message}`, {
      issues: parsed.issues,
    });
  }
  const manifest = parsed.manifest;
  // Only code compiled into the deployment may use the first-party id space,
  // whatever path it arrives by (audit R2 F6): first-party standing (beta
  // operations, surviving the emergency stop) goes by this prefix.
  if (source !== "bundled" && manifest.id.startsWith(`${FIRST_PARTY_PLUGIN_VENDOR}.`)) {
    throw new PluginError("manifest_reserved_vendor", `Plugin ids under ${FIRST_PARTY_PLUGIN_VENDOR}.* are reserved for apps bundled with Scalius.`);
  }
  return manifest;
}

/** Registrations of the running manifest: an off feature registers nothing. */
function registrationRows(pluginId: string, manifest: PluginManifest) {
  return [
    ...manifest.events.map((filter) => ({ kind: "event" as const, name: filter, pluginId, priority: 100 })),
    ...manifest.functions.map((fn) => ({ kind: "function" as const, name: fn.point, pluginId, priority: fn.priority })),
    // Storefront extensions render through the function pipeline under one run name.
    ...(manifest.storefront.extensions.length > 0 ? [{ kind: "function" as const, name: PLUGIN_EXTENSION_RUN, pluginId, priority: 100 }] : []),
    ...manifest.cron.map((job) => ({ kind: "cron" as const, name: job.name, pluginId, priority: 100 })),
    // One row per port the app provides: "who provides payment" is one index read.
    ...[...new Set(manifest.providers.map((provider) => provider.kind))]
      .map((kind) => ({ kind: "provider" as const, name: kind, pluginId, priority: 100 })),
  ];
}

/**
 * The app's sales channels (`manifest.salesChannels`, MARKETS-DESIGN D6), in
 * the batch of each manifest write: declared channels are upserted with the
 * manifest's names and on while the app runs; a channel the manifest no
 * longer declares is removed when no order names it, else switched off.
 */
function salesChannelStatements(
  db: Database,
  pluginId: string,
  declaredChannels: ReadonlyArray<{ id: string; name: string }>,
  running: boolean,
  /** The manifest this write replaces declared channels: only then can a row need removing. */
  hadChannels = false,
) {
  // An app without channels before or after writes nothing (most apps).
  if (declaredChannels.length === 0 && !hadChannels) return [];
  const declared = declaredChannels.map((channel, index) => ({
    id: appSalesChannelId(pluginId, channel.id),
    handle: appSalesChannelId(pluginId, channel.id),
    name: channel.name,
    kind: "app" as const,
    pluginId,
    status: running ? "active" as const : "inactive" as const,
    position: 100 + index,
  }));
  const ids = declared.map((channel) => channel.id);
  const undeclared = ids.length > 0 ? notInArray(salesChannels.id, ids) : undefined;
  return [
    ...(declared.length > 0
      ? [db.insert(salesChannels).values(declared).onConflictDoUpdate({
        target: salesChannels.id,
        set: { name: sql`excluded.name`, status: sql`excluded.status`, updatedAt: sql`unixepoch()` },
      })]
      : []),
    db.delete(salesChannels).where(and(
      eq(salesChannels.pluginId, pluginId),
      undeclared,
      sql`NOT EXISTS (SELECT 1 FROM orders WHERE orders.sales_channel_id = ${salesChannels.id} AND orders.sales_channel_id <> 'sc_online_store')`,
    )),
    db.update(salesChannels).set({ status: "inactive", updatedAt: sql`unixepoch()` }).where(and(
      eq(salesChannels.pluginId, pluginId),
      undeclared,
      eq(salesChannels.status, "active"),
    )),
  ];
}

/** The app's declared channels follow its status: on while it is active. */
function salesChannelStatusStatements(db: Database, pluginId: string, manifest: PluginManifest, running: boolean) {
  const ids = manifest.salesChannels.map((channel) => appSalesChannelId(pluginId, channel.id));
  if (ids.length === 0) return [];
  return [db.update(salesChannels)
    .set({ status: running ? "active" : "inactive", updatedAt: sql`unixepoch()` })
    .where(and(
      eq(salesChannels.pluginId, pluginId),
      inArray(salesChannels.id, ids),
      sql`${salesChannels.status} <> ${running ? "active" : "inactive"}`,
    ))];
}

/** Registration inserts for `declared` with `features` on, chunked within D1's bound-parameter limit (4 per row). */
function registrationInserts(db: Database, pluginId: string, declared: PluginManifest, features: readonly string[]) {
  const rows = registrationRows(pluginId, pluginManifestWithFeatures(declared, features));
  const statements = [];
  for (let start = 0; start < rows.length; start += 24) {
    statements.push(db.insert(pluginRegistrations).values(rows.slice(start, start + 24)));
  }
  return statements;
}

function requireSha256(value: string): string {
  if (!SHA256.test(value)) throw new PluginError("manifest_invalid", "The bundle SHA-256 must be 64 lowercase hex characters.");
  return value;
}

function isPrimaryKeyConflict(error: unknown): boolean {
  for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (/plugin_installations\.plugin_id|plugin_installations_pkey/i.test(message)) return true;
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
}

const REVISION_GUARD = "plugin_revision_conflict";

/** Fails the whole batch unless the installation is still at `expectedRevision`. */
function revisionGuard(db: Database, pluginId: string, expectedRevision: number) {
  return buildBatchGuard(
    db,
    sql`EXISTS (SELECT 1 FROM ${pluginInstallations} WHERE ${pluginInstallations.pluginId} = ${pluginId} AND ${pluginInstallations.revision} = ${expectedRevision})`,
    REVISION_GUARD,
  );
}

async function requireRevision(
  db: Database,
  pluginId: string,
  expectedRevision: number,
  updated: Array<{ revision: number }>,
): Promise<void> {
  if (updated.length > 0) return;
  const current = await db.select({ revision: pluginInstallations.revision })
    .from(pluginInstallations).where(eq(pluginInstallations.pluginId, pluginId)).get();
  if (!current) throw new PluginError("installation_not_found", `Plugin ${pluginId} is not installed.`);
  throw new PluginError(
    "installation_revision_conflict",
    `Plugin ${pluginId} changed since revision ${expectedRevision}; reload and try again.`,
    { currentRevision: current.revision },
  );
}

// ── Lifecycle ────────────────────────────────────────────────────────────

export interface InstallPluginInput {
  manifest: unknown;
  source: PluginInstallationSource;
  bundleSha256: string;
  actorUserId?: string | null;
  /** The trusted key that verified the bundle (registry or signed upload). */
  signerKeyId?: string | null;
}

/** The newest data update this app ran before (kept with its data across a keep-data uninstall). */
function migratedVersionSql(pluginId: string) {
  return sql`(SELECT COALESCE(MAX(${pluginMigrations.version}), 0) FROM ${pluginMigrations} WHERE ${pluginMigrations.pluginId} = ${pluginId})`;
}

/** Installs (status `installed`, nothing runs yet) with the manifest's setting defaults. */
export async function installPlugin(db: Database, input: InstallPluginInput): Promise<PluginInstallation> {
  const manifest = requireInstallableManifest(input.manifest, input.source);
  const sha256 = requireSha256(input.bundleSha256);
  if (await getPluginInstallation(db, manifest.id)) {
    throw new PluginError("installation_exists", `Plugin ${manifest.id} is already installed.`);
  }
  // Data kept by an earlier uninstall comes back with it, settings included,
  // but only to code from the developer who wrote it (security audit N4).
  const retained = (await readRetainedApp(db, manifest.id))?.app ?? null;
  if (retained) requireRetainedDataSigner(retained, input.signerKeyId ?? null);
  const settings = retained
    ? migrateStoredSettings(retained.settings, manifest.settings)
    : pluginSettingDefaults(manifest.settings);
  try {
    await safeBatch(db, [
      db.insert(pluginInstallations).values({
        pluginId: manifest.id,
        version: manifest.version,
        source: input.source,
        bundleSha256: sha256,
        manifestJson: JSON.stringify(manifest),
        status: "installed",
        settingsJson: JSON.stringify(settings),
        revision: 1,
        installedBy: input.actorUserId ?? null,
        installedAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
        migratedVersion: migratedVersionSql(manifest.id),
        signerKeyId: input.signerKeyId ?? null,
      }),
      // Nothing is approved yet: only the base registers (every feature starts off).
      ...registrationInserts(db, manifest.id, manifest, []),
      ...salesChannelStatements(db, manifest.id, manifest.salesChannels, false),
      forgetRetainedAppStatement(db, manifest.id),
    ] as never);
  } catch (error) {
    if (isPrimaryKeyConflict(error)) throw new PluginError("installation_exists", `Plugin ${manifest.id} is already installed.`);
    throw error;
  }
  await syncInstallationObjects(db, manifest.id, manifest);
  return requirePluginInstallation(db, manifest.id);
}

function missingRequiredSettings(installation: PluginInstallation): string[] {
  return installation.manifest.settings
    .filter((field) => field.required)
    .filter((field) => {
      const stored = installation.storedSettings[field.key];
      return field.type === "secret" ? !isSealedPluginSecret(stored) : stored === undefined || stored === null || stored === "";
    })
    .map((field) => field.key);
}

/**
 * A Super Admin approves the manifest's grant request and the plugin starts
 * running. Required settings must be filled first. The caller checks that the
 * actor is a Super Admin; the actor is recorded as the plugin's acting user.
 * `features` turns those features on with the approval (left out: the ones
 * on before, none on a first activation).
 */
export async function activatePlugin(
  db: Database,
  pluginId: string,
  options: {
    actorUserId: string;
    expectedRevision: number;
    /**
     * The grant key of the request the approver was shown. When given, a
     * manifest that changed since (a new grant request) refuses instead of
     * approving something nobody saw.
     */
    expectedGrantKey?: string;
    features?: readonly string[];
  },
): Promise<PluginInstallation> {
  const current = await requirePluginInstallation(db, pluginId);
  const features = options.features ? knownPluginFeatures(current.declaredManifest, options.features) : current.features;
  const installation = withFeatures(current, features);
  const missing = missingRequiredSettings(installation);
  if (missing.length > 0) {
    throw new PluginError("installation_settings_incomplete", `Fill in the required settings first: ${missing.join(", ")}.`, { missing });
  }
  const grant = pluginGrantRequest(installation.declaredManifest, features);
  if (options.expectedGrantKey !== undefined && options.expectedGrantKey !== pluginGrantKey(grant)) {
    throw new PluginError("installation_grant_changed", `${installation.manifest.name} now asks for different access; review it again.`, {
      currentRevision: installation.revision,
    });
  }
  try {
    await safeBatch(db, [
      revisionGuard(db, pluginId, options.expectedRevision),
      db.update(pluginInstallations).set({
        status: "active",
        grantJson: JSON.stringify(grant),
        grantKey: pluginGrantKey(grant),
        failureReason: null,
        activatedBy: options.actorUserId,
        // First approval: the app receives events from now. Approving it
        // again (after a stop, a failure or an update) keeps the first time,
        // so nothing that happened while it was off falls before it.
        activatedAt: current.grant ? sql`COALESCE(${pluginInstallations.activatedAt}, unixepoch())` : sql`unixepoch()`,
        revision: sql`${pluginInstallations.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      }).where(eq(pluginInstallations.pluginId, pluginId)),
      db.delete(pluginRegistrations).where(eq(pluginRegistrations.pluginId, pluginId)),
      ...registrationInserts(db, pluginId, installation.declaredManifest, features),
      // Its sales channels are on while it runs.
      ...salesChannelStatusStatements(db, pluginId, installation.manifest, true),
      // The events kept while it was off become due.
      releaseHeldPluginDeliveriesStatement(db, pluginId),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, REVISION_GUARD)) await requireRevision(db, pluginId, options.expectedRevision, []);
    throw error;
  }
  await syncInstallationObjects(db, pluginId, installation.manifest);
  return requirePluginInstallation(db, pluginId);
}

/** The installation as it would run with exactly `features` on. */
function withFeatures(installation: PluginInstallation, features: readonly string[]): PluginInstallation {
  const known = knownPluginFeatures(installation.declaredManifest, features);
  return { ...installation, features: known, manifest: pluginManifestWithFeatures(installation.declaredManifest, known) };
}

/**
 * Turns one of an active app's features on or off. On asks for that feature's
 * access, so the caller checks the actor is a Super Admin (a person's consent)
 * and passes the grant key of the request it showed (`expectedGrantKey`, the
 * key of `pluginGrantRequest(declared, features + feature)`); the approver
 * becomes the app's acting user. Off revokes the feature's access at once and
 * needs no approval. Either way its registrations follow in the same batch,
 * so an off feature's providers, events, functions and cron jobs stop with
 * the write. Turning on a feature that is on (or off one that is off) changes
 * nothing.
 */
export async function setPluginFeature(
  db: Database,
  pluginId: string,
  options: {
    feature: string;
    enabled: boolean;
    expectedRevision: number;
    actorUserId?: string;
    expectedGrantKey?: string;
  },
): Promise<{ installation: PluginInstallation; changed: boolean }> {
  const installation = await requirePluginInstallation(db, pluginId);
  const declared = installation.declaredManifest;
  if (!declared.features.some((feature) => feature.id === options.feature)) {
    throw new PluginError("feature_not_found", `${declared.name} has no feature ${options.feature}.`);
  }
  if (installation.revision !== options.expectedRevision) await requireRevision(db, pluginId, options.expectedRevision, []);
  const on = installation.features.includes(options.feature);
  if (on === options.enabled) return { installation, changed: false };
  if (options.enabled && (installation.status !== "active" || !installation.grant)) {
    throw new PluginError("installation_inactive", `Turn on ${declared.name} first, then its features.`);
  }
  if (!installation.grant) throw new PluginError("installation_inactive", `${declared.name} is not approved.`);
  const features = options.enabled
    ? [...installation.features, options.feature]
    : installation.features.filter((feature) => feature !== options.feature);
  const grant = pluginGrantRequest(declared, features);
  // Off only ever narrows: an update still waiting for approval is not approved by it.
  if (!options.enabled && pluginGrantExpands(installation.grant, grant)) {
    throw new PluginError("installation_needs_approval", `${declared.name} waits for its update's approval; approve or remove it first.`);
  }
  if (options.enabled && options.expectedGrantKey !== undefined && options.expectedGrantKey !== pluginGrantKey(grant)) {
    throw new PluginError("installation_grant_changed", `${declared.name} now asks for different access; review it again.`, {
      currentRevision: installation.revision,
    });
  }
  try {
    await safeBatch(db, [
      revisionGuard(db, pluginId, options.expectedRevision),
      db.update(pluginInstallations).set({
        grantJson: JSON.stringify(grant),
        grantKey: pluginGrantKey(grant),
        ...(options.enabled && options.actorUserId ? { activatedBy: options.actorUserId } : {}),
        revision: sql`${pluginInstallations.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      }).where(eq(pluginInstallations.pluginId, pluginId)),
      db.delete(pluginRegistrations).where(eq(pluginRegistrations.pluginId, pluginId)),
      ...registrationInserts(db, pluginId, declared, features),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, REVISION_GUARD)) await requireRevision(db, pluginId, options.expectedRevision, []);
    throw error;
  }
  return { installation: await requirePluginInstallation(db, pluginId), changed: true };
}

export async function deactivatePlugin(
  db: Database,
  pluginId: string,
  options: { expectedRevision: number },
): Promise<PluginInstallation> {
  const installation = await requirePluginInstallation(db, pluginId);
  try {
    await safeBatch(db, [
      revisionGuard(db, pluginId, options.expectedRevision),
      db.update(pluginInstallations).set({
        status: "disabled",
        revision: sql`${pluginInstallations.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      }).where(eq(pluginInstallations.pluginId, pluginId)),
      ...salesChannelStatusStatements(db, pluginId, installation.manifest, false),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, REVISION_GUARD)) await requireRevision(db, pluginId, options.expectedRevision, []);
    throw error;
  }
  return requirePluginInstallation(db, pluginId);
}

/**
 * The host could not load the plugin (missing bundle, hash mismatch,
 * handlers that disagree with the manifest): it stops running until an
 * update or re-activation. Runtime throws and timeouts are logged, not this.
 */
export async function markPluginFailed(db: Database, pluginId: string, reason: string): Promise<void> {
  const trimmed = reason.trim().slice(0, MAX_FAILURE_REASON) || "The plugin could not be loaded.";
  await safeBatch(db, [
    db.update(pluginInstallations).set({
      status: "failed",
      failureReason: trimmed,
      revision: sql`${pluginInstallations.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    }).where(eq(pluginInstallations.pluginId, pluginId)),
    // A failed app sells nothing: every channel of it is off.
    db.update(salesChannels).set({ status: "inactive", updatedAt: sql`unixepoch()` })
      .where(and(eq(salesChannels.pluginId, pluginId), eq(salesChannels.status, "active"))),
  ] as never);
}

/** An app cannot run against an object schema its release could not apply. */
async function syncInstallationObjects(db: Database, pluginId: string, manifest: PluginManifest): Promise<void> {
  let reason: string;
  try {
    const problems = await syncAppObjectTypes(db, pluginId, manifest.objects);
    if (problems.length === 0) return;
    reason = `${manifest.name}'s object types could not be saved: ${problems.join("; ")}`;
  } catch (error) {
    console.warn(`[plugins] ${pluginId} object types could not be synced (${error instanceof Error ? error.name : "error"})`);
    reason = `${manifest.name}'s object types could not be saved.`;
  }
  await markPluginFailed(db, pluginId, reason);
  throw new PluginError("installation_objects_invalid", reason);
}

/**
 * Data kept by a keep-data uninstall belongs to the developer whose code
 * wrote it (security audit N4). Everything an app owns is keyed by its
 * plugin id (its key/value data, records, custom fields, customer roles and
 * catalogue ownership), so a release under the same id from another signer
 * would read all of it. Such a release is refused while the data is kept:
 * the data stays listed under removed apps, where a Super Admin can delete
 * it, and the release then installs clean. The same signer (or the same
 * unsigned source) reclaims everything, settings included.
 */
function requireRetainedDataSigner(retained: RetainedApp, signerKeyId: string | null): void {
  if (retained.signerKeyId === signerKeyId) return;
  throw new PluginError(
    "retained_data_other_developer",
    `${retained.name} left data in this store that belongs to the developer who made it, and this release comes from another developer. Delete that data first (Apps, Data from removed apps); this release then starts clean.`,
    { retainedSigner: retained.signerKeyId, releaseSigner: signerKeyId },
  );
}

/** Whether any stored setting differs from its default (a sealed secret always does). */
function settingsCustomized(stored: Record<string, unknown>, schema: readonly PluginSettingField[]): boolean {
  const defaults = pluginSettingDefaults([...schema]);
  return Object.entries(stored).some(([key, value]) =>
    value !== null && value !== undefined && JSON.stringify(value) !== JSON.stringify(defaults[key] ?? null));
}

/** Stored values that are still valid under a new settings schema; new fields take their defaults. */
function migrateStoredSettings(stored: Record<string, unknown>, schema: readonly PluginSettingField[]): Record<string, unknown> {
  const next: Record<string, unknown> = { ...pluginSettingDefaults([...schema]) };
  for (const field of schema) {
    const value = stored[field.key];
    if (value === undefined || value === null) continue;
    if (field.type === "secret") {
      if (isSealedPluginSecret(value)) next[field.key] = value;
      continue;
    }
    const check = validatePluginSettingValues([{ ...field, required: false }], { [field.key]: value });
    if (check.ok && check.values[field.key] !== null && check.values[field.key] !== undefined) next[field.key] = check.values[field.key];
  }
  return next;
}

export interface UpdatePluginInput {
  manifest: unknown;
  source: PluginInstallationSource;
  bundleSha256: string;
  expectedRevision: number;
  /** The trusted key that verified the new bundle (null: bundled code or an unsigned upload). */
  signerKeyId?: string | null;
}

/**
 * The developer key an app was installed with stays its signer (audit R2
 * F6): a registry or uploaded update must be signed by the same key, so a
 * developer trusted for one app cannot ship code under another app's id and
 * grant. An app installed unsigned takes the key of its first signed update.
 * Another developer's release under this id installs only after the app is
 * uninstalled and its data deleted (`requireRetainedDataSigner`): one
 * developer's stored data never passes to another's code.
 */
export function requirePinnedSigner(
  current: { signerKeyId: string | null; manifest: { name: string } | null; pluginId: string },
  update: { source: PluginInstallationSource; signerKeyId: string | null },
): void {
  if (update.source === "bundled" || current.signerKeyId === null) return;
  if (update.signerKeyId === current.signerKeyId) return;
  const name = current.manifest?.name ?? current.pluginId;
  throw new PluginError(
    "signature_signer_changed",
    update.signerKeyId === null
      ? `${name} was installed from a signed release; an update must be signed by the same developer.`
      : `${name} was installed from a release signed by another developer. An update must come from the same developer.`,
    { installedSigner: current.signerKeyId, releaseSigner: update.signerKeyId },
  );
}

/**
 * Replaces the code and manifest. An active plugin whose new grant request
 * asks for anything not yet approved waits in `installed` for a Super Admin
 * (the old grant is kept on record, `pluginNeedsApproval` reports it); a
 * narrower one stays active. A `failed` plugin was running when it failed
 * (only active plugins run), so an update resumes it the same way: active
 * when its grant still covers the new request, else waiting for approval.
 * Object types and their indexes are reconciled before new code runs. A
 * row whose stored manifest no longer reads is replaced the same way
 * (`installationBeforeUpdate`): its approved grant still decides.
 */
export async function updatePluginInstallation(
  db: Database,
  pluginId: string,
  input: UpdatePluginInput,
): Promise<PluginInstallation> {
  const current = await installationBeforeUpdate(db, pluginId);
  const manifest = requireInstallableManifest(input.manifest, input.source);
  if (manifest.id !== pluginId) throw new PluginError("manifest_invalid", `The manifest is for ${manifest.id}, not ${pluginId}.`);
  requirePinnedSigner({ ...current, pluginId }, { source: input.source, signerKeyId: input.signerKeyId ?? null });
  const sha256 = requireSha256(input.bundleSha256);
  // Features stay as they were (those the new manifest still declares); a new feature starts off.
  const features = knownPluginFeatures(manifest, current.features);
  const request = pluginGrantRequest(manifest, features);
  const wasRunning = current.status === "active" || (current.status === "failed" && current.grant !== null && current.activatedBy !== null);
  const needsApproval = wasRunning && (!current.grant || pluginGrantExpands(current.grant, request));
  const status: PluginInstallationStatus = wasRunning ? (needsApproval ? "installed" : "active") : current.status;
  const grant = wasRunning && !needsApproval ? request : current.grant;
  const settings = migrateStoredSettings(current.storedSettings, manifest.settings);
  // While it waits for approval it keeps running nothing new: registrations follow the grant it has.
  const registered = grant === request ? features : knownPluginFeatures(manifest, grant?.features ?? []);

  try {
    await safeBatch(db, [
      revisionGuard(db, pluginId, input.expectedRevision),
      db.update(pluginInstallations).set({
        version: manifest.version,
        source: input.source,
        bundleSha256: sha256,
        manifestJson: JSON.stringify(manifest),
        status,
        failureReason: null,
        grantJson: grant ? JSON.stringify(grant) : null,
        grantKey: grant ? pluginGrantKey(grant) : null,
        settingsJson: JSON.stringify(settings),
        signerKeyId: input.signerKeyId ?? null,
        revision: sql`${pluginInstallations.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      }).where(eq(pluginInstallations.pluginId, pluginId)),
      db.delete(pluginRegistrations).where(eq(pluginRegistrations.pluginId, pluginId)),
      ...registrationInserts(db, pluginId, manifest, registered),
      ...salesChannelStatements(db, pluginId, manifest.salesChannels, status === "active", (current.manifest?.salesChannels.length ?? 1) > 0),
      // A failed app the update resumes receives the events kept while it was off.
      ...(status === "active" ? [releaseHeldPluginDeliveriesStatement(db, pluginId)] : []),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, REVISION_GUARD)) await requireRevision(db, pluginId, input.expectedRevision, []);
    throw error;
  }

  await syncInstallationObjects(db, pluginId, manifest);
  return requirePluginInstallation(db, pluginId);
}

/**
 * Puts back the release an update replaced (its code, manifest, grant,
 * status and settings as they were), after the update failed: a data update
 * threw or the new code could not load. Data updates stay recorded; object
 * declarations follow the restored release, removing types it does not
 * declare and their records. `reason` is the failure reason the dashboard shows.
 */
export async function restorePluginRelease(
  db: Database,
  previous: PluginInstallation,
  options: { expectedRevision: number; reason: string },
): Promise<PluginInstallation> {
  const pluginId = previous.pluginId;
  const current = await requirePluginInstallation(db, pluginId);
  // A rollback point saved before features existed has only `manifest` (then the whole declaration).
  const declared = previous.declaredManifest ?? previous.manifest;
  const features = knownPluginFeatures(declared, previous.grant?.features ?? []);
  try {
    await safeBatch(db, [
      revisionGuard(db, pluginId, options.expectedRevision),
      db.update(pluginInstallations).set({
        version: previous.version,
        source: previous.source,
        bundleSha256: previous.bundleSha256,
        manifestJson: JSON.stringify(declared),
        status: previous.status,
        failureReason: options.reason.trim().slice(0, MAX_FAILURE_REASON) || null,
        grantJson: previous.grant ? JSON.stringify(previous.grant) : null,
        grantKey: previous.grant ? pluginGrantKey(previous.grant) : null,
        settingsJson: JSON.stringify(previous.storedSettings),
        signerKeyId: previous.signerKeyId,
        revision: sql`${pluginInstallations.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      }).where(eq(pluginInstallations.pluginId, pluginId)),
      db.delete(pluginRegistrations).where(eq(pluginRegistrations.pluginId, pluginId)),
      ...registrationInserts(db, pluginId, declared, features),
      ...salesChannelStatements(db, pluginId, declared.salesChannels, previous.status === "active", current.manifest.salesChannels.length > 0),
      ...(previous.status === "active" ? [releaseHeldPluginDeliveriesStatement(db, pluginId)] : []),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, REVISION_GUARD)) await requireRevision(db, pluginId, options.expectedRevision, []);
    throw error;
  }
  await syncInstallationObjects(db, pluginId, declared);
  return requirePluginInstallation(db, pluginId);
}

/**
 * Removes the installation (its registrations go with it), in one batch.
 * `keepData: true` keeps everything the plugin owns for a reinstall: storage
 * records, KV, logs, the delivery and cron history (deliveries still waiting
 * are cancelled), its custom fields, and its name and settings
 * (`retainAppStatement`): a reinstall takes the settings back. `keepData:
 * false` deletes all of it (`appDataDeleteStatements`), including its
 * custom-field namespace (definitions and, by cascade, values), the customer
 * roles it granted, its background jobs and which catalogue items it created;
 * the caller deletes the trashed ones of those (`listAppCreatedResources`,
 * read before this). Either way a job still running stops (`app_inactive`).
 */
export async function uninstallPlugin(
  db: Database,
  pluginId: string,
  options: { keepData: boolean; expectedRevision: number },
): Promise<void> {
  const waiting = ["pending", "processing", "failed"] as const;
  const read = await readPluginInstallation(db, pluginId);
  const installed = read?.readable ? read.installation : null;
  const hadChannels = (installed?.manifest.salesChannels.length ?? 0) > 0;
  // Read here: a query builder is a thenable, so the statement is built, never awaited, below.
  const previousRetained = options.keepData ? (await readRetainedApp(db, pluginId))?.app?.revision ?? 0 : 0;
  const retain = () => {
    const settings = installed?.storedSettings ?? {};
    return retainAppStatement(db, pluginId, {
      name: installed?.declaredManifest.name ?? (read && !read.readable ? read.installation.name : null) ?? pluginId,
      version: read?.installation.version ?? "",
      source: read?.installation.source ?? "upload",
      signerKeyId: installed?.signerKeyId ?? null,
      settings,
      settingsCustomized: installed ? settingsCustomized(settings, installed.declaredManifest.settings) : false,
    }, previousRetained);
  };
  try {
    await safeBatch(db, [
      revisionGuard(db, pluginId, options.expectedRevision),
      db.delete(pluginInstallations).where(eq(pluginInstallations.pluginId, pluginId)),
      // Its own webhook endpoints go with it, kept data or not (their deliveries cascade).
      db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.pluginId, pluginId)),
      // Its channels go (or, when orders name them, stay switched off).
      ...salesChannelStatements(db, pluginId, [], false, hadChannels),
      // Its running jobs stop with it (kept or deleted below).
      db.update(bulkRuns).set({
        status: "failed",
        errorCode: "app_inactive",
        finishedAt: sql`unixepoch()`,
        leaseUntil: null,
        updatedAt: sql`unixepoch()`,
      }).where(and(appJobRowsCondition(pluginId), eq(bulkRuns.status, "running"))),
      ...(options.keepData
        ? [
          db.update(pluginEventDeliveries).set({
            status: "cancelled",
            claimId: null,
            claimExpiresAt: null,
            lastError: "The app was uninstalled.",
            nextAttemptAt: 253_402_300_799,
            updatedAt: sql`unixepoch()`,
          }).where(and(eq(pluginEventDeliveries.pluginId, pluginId), inArray(pluginEventDeliveries.status, [...waiting]))),
          retain(),
        ]
        : appDataDeleteStatements(db, pluginId)),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, REVISION_GUARD)) await requireRevision(db, pluginId, options.expectedRevision, []);
    throw error;
  }
}

/**
 * An update asked for access the approved grant does not cover: the plugin
 * waits (`installed`) until a Super Admin approves the new request.
 */
export function pluginNeedsApproval(installation: PluginInstallation): boolean {
  return installation.status !== "active"
    && installation.grant !== null
    && pluginGrantExpands(installation.grant, pluginGrantRequest(installation.declaredManifest, installation.features));
}

// ── Settings ─────────────────────────────────────────────────────────────

/**
 * Validates a settings write against the manifest schema (full document for
 * plain fields; an omitted secret keeps its stored value, `null` clears it)
 * and seals secrets. Plaintext secrets never reach the database.
 */
export async function writePluginSettings(
  db: Database,
  pluginId: string,
  values: Record<string, unknown>,
  options: { expectedRevision: number; credentialEncryptionKey: string | null | undefined },
): Promise<PluginInstallation> {
  const installation = await requirePluginInstallation(db, pluginId);
  const schema = installation.manifest.settings;
  // A feature that is off has no settings to write: say which feature to turn on.
  const live = new Set(schema.map((field) => field.key));
  const dormant = Object.keys(values).find((key) => !live.has(key) && installation.declaredManifest.settings.some((field) => field.key === key));
  if (dormant) {
    const owner = pluginFeatureOwners(installation.declaredManifest).settings.get(dormant);
    const feature = installation.declaredManifest.features.find((entry) => entry.id === owner);
    const message = `Turn on ${feature?.name ?? "its feature"} first.`;
    throw new PluginError("settings_invalid", `${dormant}: ${message}`, { errors: [{ key: dormant, message }] });
  }
  const secretsSet = new Set(schema
    .filter((field) => field.type === "secret" && isSealedPluginSecret(installation.storedSettings[field.key]))
    .map((field) => field.key));
  const checked = validatePluginSettingValues(schema, values, secretsSet);
  if (!checked.ok) {
    throw new PluginError("settings_invalid", checked.errors[0] ? `${checked.errors[0].key}: ${checked.errors[0].message}` : "Invalid settings.", {
      errors: checked.errors,
    });
  }
  // A provider's own settings never take an obvious placeholder ("test", "your api key"):
  // the provider would read as not configured anyway, so the save says why now.
  const providerKeys = new Set(installation.manifest.providers.flatMap((provider) => provider.settings ?? []));
  const placeholder = schema.find((field) => providerKeys.has(field.key)
    && typeof checked.values[field.key] === "string"
    && looksLikePlaceholderCredential(checked.values[field.key] as string));
  if (placeholder) {
    const message = `${placeholder.label} looks like a placeholder. Save a real provider value.`;
    throw new PluginError("settings_invalid", `${placeholder.key}: ${message}`, { errors: [{ key: placeholder.key, message }] });
  }
  const writesSecret = schema.some((field) => field.type === "secret" && typeof checked.values[field.key] === "string");
  const key = writesSecret ? await derivePluginSettingsKey(options.credentialEncryptionKey) : null;
  // The settings of features that are off are not in this document: they stay as stored.
  const next: Record<string, unknown> = {};
  for (const field of installation.declaredManifest.settings) {
    const stored = installation.storedSettings[field.key];
    if (!live.has(field.key) && stored !== undefined && stored !== null) next[field.key] = stored;
  }
  for (const field of schema) {
    const value = checked.values[field.key];
    if (field.type === "secret") {
      if (typeof value === "string") next[field.key] = await sealPluginSecret(key!, pluginId, field.key, value);
      else if (value === undefined && secretsSet.has(field.key)) next[field.key] = installation.storedSettings[field.key];
      continue;
    }
    if (value !== undefined && value !== null) next[field.key] = value;
  }
  const updated = await db.update(pluginInstallations).set({
    settingsJson: JSON.stringify(next),
    revision: sql`${pluginInstallations.revision} + 1`,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(pluginInstallations.pluginId, pluginId),
    eq(pluginInstallations.revision, options.expectedRevision),
  )).returning({ revision: pluginInstallations.revision });
  await requireRevision(db, pluginId, options.expectedRevision, updated);
  return requirePluginInstallation(db, pluginId);
}

/** What the dashboard may show: plain values and, for secrets, only whether one is set. */
export function describePluginSettings(installation: PluginInstallation): {
  values: PluginSettingValues;
  secrets: Record<string, boolean>;
} {
  const values: PluginSettingValues = {};
  const secrets: Record<string, boolean> = {};
  const defaults = pluginSettingDefaults(installation.manifest.settings);
  for (const field of installation.manifest.settings) {
    const stored = installation.storedSettings[field.key];
    if (field.type === "secret") secrets[field.key] = isSealedPluginSecret(stored);
    else values[field.key] = (stored ?? defaults[field.key] ?? null) as PluginSettingValue;
  }
  return { values, secrets };
}

/**
 * The settings a handler receives: defaults, stored values and opened
 * secrets. A secret that cannot be opened (key missing or rotated) reads as
 * null and is reported so the host can log it; it never fails the call.
 */
export async function readPluginRuntimeSettings(
  installation: PluginInstallation,
  credentialEncryptionKey: string | null | undefined,
): Promise<{ values: PluginSettingValues; unreadableSecrets: string[] }> {
  const { values } = describePluginSettings(installation);
  const unreadableSecrets: string[] = [];
  const sealed = installation.manifest.settings.filter((field) =>
    field.type === "secret" && isSealedPluginSecret(installation.storedSettings[field.key]));
  for (const field of installation.manifest.settings) {
    if (field.type === "secret") values[field.key] = null;
  }
  if (sealed.length === 0) return { values, unreadableSecrets };
  const key = await derivePluginSettingsKey(credentialEncryptionKey).catch(() => null);
  if (!key) return { values, unreadableSecrets: sealed.map((field) => field.key) };
  for (const field of sealed) {
    const opened = await openPluginSecret(key, installation.pluginId, field.key, installation.storedSettings[field.key] as string);
    if (opened === null) unreadableSecrets.push(field.key);
    else values[field.key] = opened;
  }
  return { values, unreadableSecrets };
}
