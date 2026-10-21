// What an app leaves in the store, and the one delete of it
// (docs/platform/PLUGINS.md, "Uninstalling"). Everything an app owns is keyed
// by its plugin id, not by the installation row: its object types (namespace)
// and records, custom fields (namespace) and values, key/value data, the
// customer roles it granted, its background jobs, the catalogue items it
// created (`app_resource_owners`), its webhook endpoints, logs, delivery,
// cron and data-update history. An uninstall that keeps data also keeps the
// app's name and settings in `system_kv` (`plugin-retained:<id>`), so a
// reinstall picks its settings up again and the dashboard can name the data
// of an app that is no longer installed (any source, including a bundled app
// removed from the deployment). Reinstalling reclaims all of it: every
// reader keys on the plugin id. So only the same developer reclaims it
// (security audit N4): `installPlugin` refuses a release under that id from
// another signer while the data is kept, and the data stays here, listed and
// deletable, until a Super Admin deletes it.
//
// `appDataDeleteStatements` is the one delete, used by an uninstall that does
// not keep data and by "Delete data" on a removed app's group. Catalogue
// items the app created are not deleted here: the caller runs the staff
// permanent delete on the trashed ones (its rules hold) and the rest become
// the store's own when their ownership rows go.

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import {
  APP_JOB_RUN_KIND,
  appResourceOwners,
  bulkRuns,
  customFieldDefinitions,
  objectTypes,
  pluginCronRuns,
  pluginCustomerRoles,
  pluginEventDeliveries,
  pluginInstallations,
  pluginKv,
  pluginLogEntries,
  pluginMigrations,
  systemKv,
  webhookSubscriptions,
  type AppOwnedResourceType,
  type PluginInstallationSource,
} from "@scalius/database/schema";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { listObjectTypes } from "../objects";
import { appJobKeyPrefix, appJobRowsCondition } from "./app-jobs";
import { PluginError } from "./errors";

const RETAINED_PREFIX = "plugin-retained:";
const MAX_NAME = 80;

/** The `system_kv` key that keeps a removed app's name and settings. */
export function retainedAppKey(pluginId: string): string {
  return `${RETAINED_PREFIX}${pluginId}`;
}

/** What an uninstall that keeps data remembers about the app. */
export interface RetainedApp {
  /** The app's name when it was removed. */
  name: string;
  version: string;
  source: PluginInstallationSource;
  /** The developer key it was installed with: a reinstall under another key gets no secret back. */
  signerKeyId: string | null;
  /** Stored settings (secrets stay sealed). */
  settings: Record<string, unknown>;
  /** Whether any setting differed from its default. */
  settingsCustomized: boolean;
  /** Epoch seconds. */
  removedAt: number;
  /** Advances with every removal: the precondition of "Delete data". */
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetained(value: string): RetainedApp | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.name !== "string" || !Number.isSafeInteger(parsed.revision) || (parsed.revision as number) < 1) return null;
  const source = parsed.source === "bundled" || parsed.source === "registry" || parsed.source === "upload" ? parsed.source : "upload";
  return {
    name: parsed.name.trim().slice(0, MAX_NAME) || "",
    version: typeof parsed.version === "string" ? parsed.version : "",
    source,
    signerKeyId: typeof parsed.signerKeyId === "string" ? parsed.signerKeyId : null,
    settings: isRecord(parsed.settings) ? parsed.settings : {},
    settingsCustomized: parsed.settingsCustomized === true,
    removedAt: Number.isSafeInteger(parsed.removedAt) ? parsed.removedAt as number : 0,
    revision: parsed.revision as number,
  };
}

/** The retained record and its stored text (the delete's compare-and-set value); null when none. */
export async function readRetainedApp(db: Database, pluginId: string): Promise<{ stored: string; app: RetainedApp | null } | null> {
  const row = await db.select({ value: systemKv.value }).from(systemKv).where(eq(systemKv.key, retainedAppKey(pluginId))).get();
  return row ? { stored: row.value, app: parseRetained(row.value) } : null;
}

/** Writes (or replaces) the retained record of an app being uninstalled with its data kept. */
export function retainAppStatement(
  db: Database,
  pluginId: string,
  app: Omit<RetainedApp, "revision" | "removedAt">,
  previousRevision: number,
) {
  const value = JSON.stringify({
    ...app,
    name: app.name.trim().slice(0, MAX_NAME),
    removedAt: Math.floor(Date.now() / 1000),
    revision: previousRevision + 1,
  });
  return db.insert(systemKv).values({ key: retainedAppKey(pluginId), value, expiresAt: null })
    .onConflictDoUpdate({ target: systemKv.key, set: { value: sql`excluded.value`, expiresAt: null } });
}

/** Forgets the retained record (a reinstall took it, or the data was deleted). */
export function forgetRetainedAppStatement(db: Database, pluginId: string) {
  return db.delete(systemKv).where(eq(systemKv.key, retainedAppKey(pluginId)));
}

/**
 * Every statement that permanently deletes what the app owns, for one batch.
 * Records go with their object types and custom-field values with their
 * definitions (cascades, so their cache-dependency triggers fire).
 */
export function appDataDeleteStatements(db: Database, pluginId: string) {
  return [
    db.delete(pluginKv).where(eq(pluginKv.pluginId, pluginId)),
    db.delete(pluginLogEntries).where(eq(pluginLogEntries.pluginId, pluginId)),
    db.delete(pluginEventDeliveries).where(eq(pluginEventDeliveries.pluginId, pluginId)),
    db.delete(pluginCronRuns).where(eq(pluginCronRuns.pluginId, pluginId)),
    // Its data is gone, so a reinstall runs every data update again.
    db.delete(pluginMigrations).where(eq(pluginMigrations.pluginId, pluginId)),
    // Plugin namespaces are plugin ids (COMMERCE-HOOKS H4); values cascade.
    db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.namespace, pluginId)),
    // Its object types and, by cascade, their records.
    db.delete(objectTypes).where(eq(objectTypes.namespace, pluginId)),
    // The roles it granted customers and its background jobs.
    db.delete(pluginCustomerRoles).where(eq(pluginCustomerRoles.pluginId, pluginId)),
    db.delete(bulkRuns).where(appJobRowsCondition(pluginId)),
    // Which catalogue items it created: the items themselves stay the store's.
    db.delete(appResourceOwners).where(eq(appResourceOwners.pluginId, pluginId)),
    db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.pluginId, pluginId)),
    forgetRetainedAppStatement(db, pluginId),
  ];
}

/** The catalogue items an app created that sit in the trash: what its data delete permanently deletes. */
export async function listAppCreatedResources(db: Database, pluginId: string): Promise<Array<{ type: AppOwnedResourceType; id: string }>> {
  return db.select({ type: appResourceOwners.resourceType, id: appResourceOwners.resourceId })
    .from(appResourceOwners)
    .where(eq(appResourceOwners.pluginId, pluginId))
    .orderBy(asc(appResourceOwners.resourceType), asc(appResourceOwners.resourceId))
    .all();
}

/** One removed app's data, as the dashboard lists it. */
export interface RemovedAppData {
  pluginId: string;
  /** The app's name when it was removed; its id when the store never recorded one. */
  name: string;
  removedAt: number | null;
  /** The "Delete data" precondition: 0 when the store kept no record of the removal. */
  revision: number;
  objectTypes: number;
  records: number;
  /** Object types the dashboard lists (`admin` read or edit), with their handles. */
  objectTypeHandles: string[];
  customFields: number;
  keyValues: number;
  customerRoles: number;
  jobs: number;
  /** Catalogue items it created (they stay; trashed ones are deleted with the data). */
  catalogItems: number;
  settings: boolean;
}

function emptyGroup(pluginId: string): RemovedAppData {
  return {
    pluginId,
    name: pluginId,
    removedAt: null,
    revision: 0,
    objectTypes: 0,
    records: 0,
    objectTypeHandles: [],
    customFields: 0,
    keyValues: 0,
    customerRoles: 0,
    jobs: 0,
    catalogItems: 0,
    settings: false,
  };
}

/**
 * The data of every app that is no longer installed, by app, in name order.
 * Reads one grouped count per kind (index ranges keyed by plugin id); an app
 * whose only trace is history (logs, deliveries) or untouched settings is
 * not listed.
 */
export async function listRemovedAppData(db: Database): Promise<RemovedAppData[]> {
  const installed = new Set((await db.select({ id: pluginInstallations.pluginId }).from(pluginInstallations).all()).map((row) => row.id));
  const groups = new Map<string, RemovedAppData>();
  const group = (pluginId: string) => {
    if (installed.has(pluginId)) return null;
    let entry = groups.get(pluginId);
    if (!entry) groups.set(pluginId, entry = emptyGroup(pluginId));
    return entry;
  };
  for (const type of await listObjectTypes(db)) {
    if (type.namespace === "custom") continue;
    const entry = group(type.namespace);
    if (!entry) continue;
    entry.objectTypes += 1;
    entry.records += type.recordCount;
    if (type.admin !== "none") entry.objectTypeHandles.push(type.handle);
  }
  const counted = async (
    rows: Promise<Array<{ id: string | null; n: number }>>,
    field: "customFields" | "keyValues" | "customerRoles" | "jobs" | "catalogItems",
  ) => {
    for (const row of await rows) {
      const entry = row.id ? group(row.id) : null;
      if (entry) entry[field] += Number(row.n);
    }
  };
  await counted(db.select({ id: customFieldDefinitions.namespace, n: count() }).from(customFieldDefinitions)
    .where(ne(customFieldDefinitions.namespace, "custom")).groupBy(customFieldDefinitions.namespace).all(), "customFields");
  await counted(db.select({ id: pluginKv.pluginId, n: count() }).from(pluginKv).groupBy(pluginKv.pluginId).all(), "keyValues");
  await counted(db.select({ id: pluginCustomerRoles.pluginId, n: count() }).from(pluginCustomerRoles)
    .groupBy(pluginCustomerRoles.pluginId).all(), "customerRoles");
  await counted(db.select({ id: appResourceOwners.pluginId, n: count() }).from(appResourceOwners)
    .groupBy(appResourceOwners.pluginId).all(), "catalogItems");
  // App job keys are `app:<plugin id>:<job>:...` (app-jobs.ts); plugin ids hold no `:`.
  const jobPrefix = appJobKeyPrefix("").slice(0, -1);
  // Inlined, so the selected and grouped expressions are the same text on every provider.
  const start = sql.raw(String(jobPrefix.length + 1));
  const jobOwner = sql<string>`substr(${bulkRuns.operationKey}, ${start}, instr(substr(${bulkRuns.operationKey}, ${start}), ':') - 1)`;
  await counted(db.select({ id: jobOwner, n: count() }).from(bulkRuns)
    .where(and(eq(bulkRuns.kind, APP_JOB_RUN_KIND), sql`substr(${bulkRuns.operationKey}, 1, ${sql.raw(String(jobPrefix.length))}) = ${jobPrefix}`))
    .groupBy(jobOwner).all(), "jobs");
  const retained = await db.select({ key: systemKv.key, value: systemKv.value }).from(systemKv)
    .where(sql`substr(${systemKv.key}, 1, ${sql.raw(String(RETAINED_PREFIX.length))}) = ${RETAINED_PREFIX}`).all();
  for (const row of retained) {
    const pluginId = row.key.slice(RETAINED_PREFIX.length);
    const app = parseRetained(row.value);
    if (installed.has(pluginId) || !app) continue;
    const entry = groups.get(pluginId) ?? (app.settingsCustomized ? group(pluginId) : null);
    if (!entry) continue;
    if (app.name) entry.name = app.name;
    entry.removedAt = app.removedAt || null;
    entry.revision = app.revision;
    entry.settings = app.settingsCustomized;
  }
  return [...groups.values()]
    .filter((entry) => entry.objectTypes + entry.customFields + entry.keyValues + entry.customerRoles + entry.jobs + entry.catalogItems > 0 || entry.settings)
    .map((entry) => ({ ...entry, objectTypeHandles: entry.objectTypeHandles.sort() }))
    .sort((left, right) => left.name.localeCompare(right.name, "en") || left.pluginId.localeCompare(right.pluginId, "en"));
}

const NOT_INSTALLED_GUARD = "app_data_installed";
const RETAINED_GUARD = "app_data_changed";

/**
 * Permanently deletes the data of an app that is not installed, if it is
 * still what the caller saw: `expectedRevision` is the listed `revision`
 * (0 when the store kept no record of the removal). Refused while the app is
 * installed (it owns its data again) or once it was removed again since.
 */
export async function deleteRemovedAppData(db: Database, pluginId: string, expectedRevision: number): Promise<void> {
  const changed = (currentRevision: number) => new PluginError(
    "installation_revision_conflict",
    `The data of ${pluginId} changed since revision ${expectedRevision}; reload and try again.`,
    { currentRevision },
  );
  const installedAgain = () => new PluginError("installation_exists", `${pluginId} is installed again and owns its data; uninstall it to delete the data.`);
  if (await db.select({ id: pluginInstallations.pluginId }).from(pluginInstallations).where(eq(pluginInstallations.pluginId, pluginId)).get()) {
    throw installedAgain();
  }
  const retained = await readRetainedApp(db, pluginId);
  // A record this release cannot read lists as 0; the batch still compares its stored text.
  const current = retained?.app?.revision ?? 0;
  if (current !== expectedRevision) throw changed(current);
  const keyMatches = retained
    ? sql`EXISTS (SELECT 1 FROM ${systemKv} WHERE ${systemKv.key} = ${retainedAppKey(pluginId)} AND ${systemKv.value} = ${retained.stored})`
    : sql`NOT EXISTS (SELECT 1 FROM ${systemKv} WHERE ${systemKv.key} = ${retainedAppKey(pluginId)})`;
  try {
    await safeBatch(db, [
      buildBatchGuard(db, sql`NOT EXISTS (SELECT 1 FROM ${pluginInstallations} WHERE ${pluginInstallations.pluginId} = ${pluginId})`, NOT_INSTALLED_GUARD),
      buildBatchGuard(db, keyMatches, RETAINED_GUARD),
      ...appDataDeleteStatements(db, pluginId),
    ] as never);
  } catch (error) {
    if (isBatchGuardError(error, NOT_INSTALLED_GUARD)) throw installedAgain();
    if (isBatchGuardError(error, RETAINED_GUARD)) throw changed((await readRetainedApp(db, pluginId))?.app?.revision ?? 0);
    throw error;
  }
}
