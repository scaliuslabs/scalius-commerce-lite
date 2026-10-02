// Who runs at an extension point. One read through `plugin_registrations`
// (primary key kind, name, plugin) joined to active installations: when no
// active plugin declares the point the read returns nothing and the caller
// does no plugin work at all.

import type { Database } from "@scalius/database/client";
import { pluginInstallations, pluginRegistrations } from "@scalius/database/schema";
import type { PluginFunctionPoint } from "@scalius/shared/plugins";
import { and, asc, eq, inArray } from "drizzle-orm";
import { toPluginInstallation, type PluginInstallation } from "./installations";

export interface RegisteredPlugin {
  installation: PluginInstallation;
  priority: number;
  /** The registration's name: the function point, topic filter or cron job. */
  name: string;
}

async function activeRegistrations(db: Database, kind: "event" | "function" | "cron", names: readonly string[]): Promise<RegisteredPlugin[]> {
  if (names.length === 0) return [];
  const rows = await db.select({ priority: pluginRegistrations.priority, name: pluginRegistrations.name, installation: pluginInstallations })
    .from(pluginRegistrations)
    .innerJoin(pluginInstallations, eq(pluginInstallations.pluginId, pluginRegistrations.pluginId))
    .where(and(
      eq(pluginRegistrations.kind, kind),
      names.length === 1 ? eq(pluginRegistrations.name, names[0]!) : inArray(pluginRegistrations.name, [...names]),
      eq(pluginInstallations.status, "active"),
    ))
    .orderBy(asc(pluginRegistrations.priority), asc(pluginRegistrations.pluginId))
    .all();
  const result: RegisteredPlugin[] = [];
  for (const row of rows) {
    const installation = toPluginInstallation(row.installation);
    if (installation) result.push({ installation, priority: row.priority, name: row.name });
  }
  return result;
}

/** Active plugins implementing a function point, by priority then plugin id. */
export function listActiveFunctionPlugins(db: Database, point: PluginFunctionPoint): Promise<RegisteredPlugin[]> {
  return activeRegistrations(db, "function", [point]);
}

/**
 * Every active function registration, all points at once, as one statement
 * a caller can add to a read batch it already makes (checkout does). No
 * active implementation: no rows, and checkout does no plugin work at all.
 */
export function selectActiveFunctionRegistrations(db: Database) {
  return db.select({ priority: pluginRegistrations.priority, name: pluginRegistrations.name, installation: pluginInstallations })
    .from(pluginRegistrations)
    .innerJoin(pluginInstallations, eq(pluginInstallations.pluginId, pluginRegistrations.pluginId))
    .where(and(eq(pluginRegistrations.kind, "function"), eq(pluginInstallations.status, "active")))
    .orderBy(asc(pluginRegistrations.priority), asc(pluginRegistrations.pluginId));
}

export interface ActiveFunctionRegistrationRow {
  priority: number;
  name: string;
  installation: typeof pluginInstallations.$inferSelect;
}

/** The rows of `selectActiveFunctionRegistrations`, parsed (an unreadable manifest is skipped). */
export function resolveActiveFunctionRegistrations(rows: readonly ActiveFunctionRegistrationRow[]): RegisteredPlugin[] {
  const result: RegisteredPlugin[] = [];
  for (const row of rows) {
    const installation = toPluginInstallation(row.installation);
    if (installation) result.push({ installation, priority: row.priority, name: row.name });
  }
  return result;
}

/** Every active function registration (all points), by priority then plugin id. */
export async function listActiveFunctionRegistrations(db: Database): Promise<RegisteredPlugin[]> {
  return resolveActiveFunctionRegistrations(await selectActiveFunctionRegistrations(db).all());
}

/** Active plugins subscribed to a topic through its exact name, its resource wildcard or `*` (one row per plugin). */
export async function listActiveEventPlugins(db: Database, topic: string): Promise<RegisteredPlugin[]> {
  const prefix = topic.split(".", 1)[0];
  const rows = await activeRegistrations(db, "event", [topic, `${prefix}.*`, "*"]);
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.installation.pluginId) && Boolean(seen.add(row.installation.pluginId)));
}

/** Whether any active plugin subscribes to any topic: the event pipeline's "nobody listens" check. */
export async function hasActiveEventPlugins(db: Database): Promise<boolean> {
  const row = await db.select({ pluginId: pluginRegistrations.pluginId })
    .from(pluginRegistrations)
    .innerJoin(pluginInstallations, eq(pluginInstallations.pluginId, pluginRegistrations.pluginId))
    .where(and(eq(pluginRegistrations.kind, "event"), eq(pluginInstallations.status, "active")))
    .limit(1)
    .get();
  return Boolean(row);
}

/** Every cron job of every active plugin (one row per job), by plugin id then job name. */
export async function listActiveCronJobs(db: Database): Promise<RegisteredPlugin[]> {
  const rows = await db.select({ priority: pluginRegistrations.priority, name: pluginRegistrations.name, installation: pluginInstallations })
    .from(pluginRegistrations)
    .innerJoin(pluginInstallations, eq(pluginInstallations.pluginId, pluginRegistrations.pluginId))
    .where(and(eq(pluginRegistrations.kind, "cron"), eq(pluginInstallations.status, "active")))
    .orderBy(asc(pluginRegistrations.pluginId), asc(pluginRegistrations.name))
    .all();
  const result: RegisteredPlugin[] = [];
  for (const row of rows) {
    const installation = toPluginInstallation(row.installation);
    if (installation) result.push({ installation, priority: row.priority, name: row.name });
  }
  return result;
}

export async function getActivePluginInstallation(db: Database, pluginId: string): Promise<PluginInstallation | null> {
  const row = await db.select().from(pluginInstallations)
    .where(and(eq(pluginInstallations.pluginId, pluginId), eq(pluginInstallations.status, "active")))
    .get();
  return row ? toPluginInstallation(row) : null;
}
