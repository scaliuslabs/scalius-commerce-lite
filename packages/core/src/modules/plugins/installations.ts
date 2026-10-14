// Plugin installations (docs/platform/PLUGINS.md, P1): install, approve and
// activate, deactivate, update, uninstall, and the merchant's settings. Every
// write is a compare-and-set on `revision`; the extension-point registrations
// are rewritten in the same batch as the manifest they derive from.

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import {
  customFieldDefinitions,
  metaobjectDefinitions,
  pluginCronRuns,
  pluginEventDeliveries,
  pluginInstallations,
  pluginKv,
  pluginLogEntries,
  pluginMigrations,
  pluginRecords,
  pluginRegistrations,
  salesChannels,
  type PluginInstallationRow,
  type PluginInstallationSource,
  type PluginInstallationStatus,
} from "@scalius/database/schema";
import { isCustomFieldType } from "@scalius/shared/custom-fields";
import { looksLikePlaceholderCredential } from "@scalius/shared/plugins/placeholder-credentials";
import {
  FIRST_PARTY_PLUGIN_VENDOR,
  isPluginScope,
  legacyPermissionScope,
  parsePluginManifest,
  pluginCompatibility,
  pluginGrantExpands,
  pluginGrantKey,
  pluginGrantRequest,
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
import {
  derivePluginSettingsKey,
  isSealedPluginSecret,
  openPluginSecret,
  sealPluginSecret,
} from "./settings-crypto";
import { reindexPluginCollection } from "./storage";

export interface PluginInstallation {
  pluginId: string;
  version: string;
  source: PluginInstallationSource;
  bundleSha256: string;
  manifest: PluginManifest;
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
  if (typeof raw.publicRoutes !== "boolean" || typeof raw.storefrontSurfaces !== "boolean") return null;
  // Storefront components (added later): absent on grants that never asked.
  if (raw.storefrontCode !== undefined && raw.storefrontCode !== true) return null;
  const connect = raw.storefrontConnect === undefined ? undefined : stringList(raw.storefrontConnect);
  if (connect === null) return null;
  return {
    ...(parsed as Record<(typeof lists)[number], string[]>),
    publicRoutes: raw.publicRoutes,
    storefrontSurfaces: raw.storefrontSurfaces,
    ...(raw.storefrontCode === true ? { storefrontCode: true as const } : {}),
    ...(connect && connect.length > 0 ? { storefrontConnect: connect } : {}),
  } as PluginGrantRequest;
}

/**
 * A manifest stored before scopes, read as the scopes it asked for: each RBAC
 * permission becomes the first scope that confers it (`legacyPermissionScope`),
 * an admin route's `permission` gate its `scope`. Only the stored row's read
 * shape changes; its grant still needs approval (`parseStoredPluginGrant`).
 */
export function upgradeStoredPluginManifest(manifest: Record<string, unknown>): Record<string, unknown> {
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
  return {
    pluginId: row.pluginId,
    version: row.version,
    source: row.source,
    bundleSha256: row.bundleSha256,
    manifest: parsed.manifest,
    grant: parseStoredPluginGrant(row.grantJson),
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
  if (!installation) throw new PluginError("installation.not_found", `Plugin ${pluginId} is not installed.`);
  return installation;
}

export async function listPluginInstallations(db: Database): Promise<PluginInstallation[]> {
  const rows = await db.select().from(pluginInstallations).orderBy(asc(pluginInstallations.pluginId)).all();
  return rows.map(toPluginInstallation).filter((installation): installation is PluginInstallation => installation !== null);
}

// ── Manifest checks beyond the schema ────────────────────────────────────

/** A manifest the store can install: parsed, known permissions only, nothing reserved. */
export function requireInstallableManifest(value: unknown, source: PluginInstallationSource): PluginManifest {
  // The plugin API version and the platform release first: a clear "needs a
  // newer Scalius" instead of a schema error.
  const compatible = pluginCompatibility(value);
  if (!compatible.ok) throw new PluginError("installation.incompatible", compatible.message, { reason: compatible.reason });
  const parsed = parsePluginManifest(value);
  if (!parsed.ok) {
    throw new PluginError("manifest.invalid", `The plugin manifest is invalid: ${parsed.issues[0]?.path} ${parsed.issues[0]?.message}`, {
      issues: parsed.issues,
    });
  }
  const manifest = parsed.manifest;
  const badType = manifest.customFields.find((field) => !isCustomFieldType(field.type));
  if (badType) {
    throw new PluginError("manifest.custom_field_type", `Unknown custom field type ${badType.type}.`);
  }
  if (source === "upload" && manifest.id.startsWith(`${FIRST_PARTY_PLUGIN_VENDOR}.`)) {
    throw new PluginError("manifest.reserved_vendor", `Plugin ids under ${FIRST_PARTY_PLUGIN_VENDOR}.* are reserved for first-party plugins.`);
  }
  return manifest;
}

function registrationRows(pluginId: string, manifest: PluginManifest) {
  return [
    ...manifest.events.map((filter) => ({ kind: "event" as const, name: filter, pluginId, priority: 100 })),
    ...manifest.functions.map((fn) => ({ kind: "function" as const, name: fn.point, pluginId, priority: fn.priority })),
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

/** Registration inserts, chunked within D1's bound-parameter limit (4 per row). */
function registrationInserts(db: Database, pluginId: string, manifest: PluginManifest) {
  const rows = registrationRows(pluginId, manifest);
  const statements = [];
  for (let start = 0; start < rows.length; start += 24) {
    statements.push(db.insert(pluginRegistrations).values(rows.slice(start, start + 24)));
  }
  return statements;
}

function requireSha256(value: string): string {
  if (!SHA256.test(value)) throw new PluginError("manifest.invalid", "The bundle SHA-256 must be 64 lowercase hex characters.");
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

const REVISION_GUARD = "PLUGIN_REVISION_CONFLICT";

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
  if (!current) throw new PluginError("installation.not_found", `Plugin ${pluginId} is not installed.`);
  throw new PluginError(
    "installation.revision_conflict",
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
    throw new PluginError("installation.exists", `Plugin ${manifest.id} is already installed.`);
  }
  try {
    await safeBatch(db, [
      db.insert(pluginInstallations).values({
        pluginId: manifest.id,
        version: manifest.version,
        source: input.source,
        bundleSha256: sha256,
        manifestJson: JSON.stringify(manifest),
        status: "installed",
        settingsJson: JSON.stringify(pluginSettingDefaults(manifest.settings)),
        revision: 1,
        installedBy: input.actorUserId ?? null,
        installedAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
        migratedVersion: migratedVersionSql(manifest.id),
        signerKeyId: input.signerKeyId ?? null,
      }),
      ...registrationInserts(db, manifest.id, manifest),
      ...salesChannelStatements(db, manifest.id, manifest.salesChannels, false),
    ] as never);
  } catch (error) {
    if (isPrimaryKeyConflict(error)) throw new PluginError("installation.exists", `Plugin ${manifest.id} is already installed.`);
    throw error;
  }
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
  },
): Promise<PluginInstallation> {
  const installation = await requirePluginInstallation(db, pluginId);
  const missing = missingRequiredSettings(installation);
  if (missing.length > 0) {
    throw new PluginError("installation.settings_incomplete", `Fill in the required settings first: ${missing.join(", ")}.`, { missing });
  }
  const grant = pluginGrantRequest(installation.manifest);
  if (options.expectedGrantKey !== undefined && options.expectedGrantKey !== pluginGrantKey(grant)) {
    throw new PluginError("installation.grant_changed", `${installation.manifest.name} now asks for different access; review it again.`, {
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
        activatedAt: sql`unixepoch()`,
        revision: sql`${pluginInstallations.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      }).where(eq(pluginInstallations.pluginId, pluginId)),
      // Its sales channels are on while it runs.
      ...salesChannelStatusStatements(db, pluginId, installation.manifest, true),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, REVISION_GUARD)) await requireRevision(db, pluginId, options.expectedRevision, []);
    throw error;
  }
  return requirePluginInstallation(db, pluginId);
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
 * Replaces the code and manifest. An active plugin whose new grant request
 * asks for anything not yet approved waits in `installed` for a Super Admin
 * (the old grant is kept on record, `pluginNeedsApproval` reports it); a
 * narrower one stays active. A `failed` plugin was running when it failed
 * (only active plugins run), so an update resumes it the same way: active
 * when its grant still covers the new request, else waiting for approval.
 * Storage collections whose index declaration changed are re-indexed.
 */
export async function updatePluginInstallation(
  db: Database,
  pluginId: string,
  input: UpdatePluginInput,
): Promise<PluginInstallation> {
  const current = await requirePluginInstallation(db, pluginId);
  const manifest = requireInstallableManifest(input.manifest, input.source);
  if (manifest.id !== pluginId) throw new PluginError("manifest.invalid", `The manifest is for ${manifest.id}, not ${pluginId}.`);
  const sha256 = requireSha256(input.bundleSha256);
  const request = pluginGrantRequest(manifest);
  const wasRunning = current.status === "active" || (current.status === "failed" && current.grant !== null && current.activatedBy !== null);
  const needsApproval = wasRunning && (!current.grant || pluginGrantExpands(current.grant, request));
  const status: PluginInstallationStatus = wasRunning ? (needsApproval ? "installed" : "active") : current.status;
  const grant = wasRunning && !needsApproval ? request : current.grant;
  const settings = migrateStoredSettings(current.storedSettings, manifest.settings);

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
      ...registrationInserts(db, pluginId, manifest),
      ...salesChannelStatements(db, pluginId, manifest.salesChannels, status === "active", current.manifest.salesChannels.length > 0),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, REVISION_GUARD)) await requireRevision(db, pluginId, input.expectedRevision, []);
    throw error;
  }

  for (const [collection, declaration] of Object.entries(manifest.storage)) {
    const before = current.manifest.storage[collection];
    if (before && JSON.stringify(before) === JSON.stringify(declaration)) continue;
    await reindexPluginCollection(db, pluginId, collection, declaration);
  }
  return requirePluginInstallation(db, pluginId);
}

/**
 * Puts back the release an update replaced (its code, manifest, grant,
 * status and settings as they were), after the update failed: a data update
 * threw or the new code could not load. Data updates that ran stay recorded
 * (a rollback never reverses data). `reason` is kept as the failure reason
 * the dashboard shows.
 */
export async function restorePluginRelease(
  db: Database,
  previous: PluginInstallation,
  options: { expectedRevision: number; reason: string },
): Promise<PluginInstallation> {
  const pluginId = previous.pluginId;
  const current = await requirePluginInstallation(db, pluginId);
  try {
    await safeBatch(db, [
      revisionGuard(db, pluginId, options.expectedRevision),
      db.update(pluginInstallations).set({
        version: previous.version,
        source: previous.source,
        bundleSha256: previous.bundleSha256,
        manifestJson: JSON.stringify(previous.manifest),
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
      ...registrationInserts(db, pluginId, previous.manifest),
      ...salesChannelStatements(db, pluginId, previous.manifest.salesChannels, previous.status === "active", current.manifest.salesChannels.length > 0),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, REVISION_GUARD)) await requireRevision(db, pluginId, options.expectedRevision, []);
    throw error;
  }
  for (const [collection, declaration] of Object.entries(previous.manifest.storage)) {
    const after = current.manifest.storage[collection];
    if (after && JSON.stringify(after) === JSON.stringify(declaration)) continue;
    await reindexPluginCollection(db, pluginId, collection, declaration);
  }
  return requirePluginInstallation(db, pluginId);
}

/**
 * Removes the installation (its registrations go with it), in one batch.
 * `keepData: true` keeps everything the plugin owns for a reinstall: storage
 * records, KV, logs, the delivery and cron history (deliveries still waiting
 * are cancelled) and its custom fields. `keepData: false` deletes all of it,
 * including its custom-field namespace (definitions and, by cascade, values).
 */
export async function uninstallPlugin(
  db: Database,
  pluginId: string,
  options: { keepData: boolean; expectedRevision: number },
): Promise<void> {
  const waiting = ["pending", "processing", "failed"] as const;
  const installed = await getPluginInstallation(db, pluginId);
  const hadChannels = (installed?.manifest.salesChannels.length ?? 0) > 0;
  try {
    await safeBatch(db, [
      revisionGuard(db, pluginId, options.expectedRevision),
      db.delete(pluginInstallations).where(eq(pluginInstallations.pluginId, pluginId)),
      // Its channels go (or, when orders name them, stay switched off).
      ...salesChannelStatements(db, pluginId, [], false, hadChannels),
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
        ]
        : [
          db.delete(pluginRecords).where(eq(pluginRecords.pluginId, pluginId)),
          db.delete(pluginKv).where(eq(pluginKv.pluginId, pluginId)),
          db.delete(pluginLogEntries).where(eq(pluginLogEntries.pluginId, pluginId)),
          db.delete(pluginEventDeliveries).where(eq(pluginEventDeliveries.pluginId, pluginId)),
          db.delete(pluginCronRuns).where(eq(pluginCronRuns.pluginId, pluginId)),
          // Its data is gone, so a reinstall runs every data update again.
          db.delete(pluginMigrations).where(eq(pluginMigrations.pluginId, pluginId)),
          // Plugin namespaces are plugin ids (COMMERCE-HOOKS H4); values cascade.
          db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.namespace, pluginId)),
          // Its content types and, by cascade, their entries.
          db.delete(metaobjectDefinitions).where(eq(metaobjectDefinitions.namespace, pluginId)),
        ]),
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
    && pluginGrantExpands(installation.grant, pluginGrantRequest(installation.manifest));
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
  const secretsSet = new Set(schema
    .filter((field) => field.type === "secret" && isSealedPluginSecret(installation.storedSettings[field.key]))
    .map((field) => field.key));
  const checked = validatePluginSettingValues(schema, values, secretsSet);
  if (!checked.ok) {
    throw new PluginError("settings.invalid", checked.errors[0] ? `${checked.errors[0].key}: ${checked.errors[0].message}` : "Invalid settings.", {
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
    throw new PluginError("settings.invalid", `${placeholder.key}: ${message}`, { errors: [{ key: placeholder.key, message }] });
  }
  const writesSecret = schema.some((field) => field.type === "secret" && typeof checked.values[field.key] === "string");
  const key = writesSecret ? await derivePluginSettingsKey(options.credentialEncryptionKey) : null;
  const next: Record<string, unknown> = {};
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
