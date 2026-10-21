// Who runs at an extension point. One read through `plugin_registrations`
// (primary key kind, name, plugin) joined to active installations: when no
// active plugin declares the point the read returns nothing and the caller
// does no plugin work at all.

import type { Database } from "@scalius/database/client";
import { pluginInstallations, pluginRegistrations } from "@scalius/database/schema";
import type { PluginRunPoint } from "@scalius/shared/plugins";
import type { ProviderKind } from "@scalius/shared/plugins/providers/kinds";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { toPluginInstallation, type PluginInstallation } from "./installations";

export interface RegisteredPlugin {
  installation: PluginInstallation;
  priority: number;
  /** The registration's name: the function point, topic filter, cron job or provider port. */
  name: string;
  /** Set when the read selected several kinds (`selectActiveCheckoutRegistrations`). */
  kind?: "event" | "function" | "cron" | "provider";
}

async function activeRegistrations(db: Database, kind: "event" | "function" | "cron" | "provider", names: readonly string[]): Promise<RegisteredPlugin[]> {
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
export function listActiveFunctionPlugins(db: Database, point: PluginRunPoint): Promise<RegisteredPlugin[]> {
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
  kind?: RegisteredPlugin["kind"];
  installation: typeof pluginInstallations.$inferSelect;
}

/** The rows of `selectActiveFunctionRegistrations` (or the checkout read), parsed (an unreadable manifest is skipped). */
export function resolveActiveFunctionRegistrations(rows: readonly ActiveFunctionRegistrationRow[]): RegisteredPlugin[] {
  const result: RegisteredPlugin[] = [];
  for (const row of rows) {
    const installation = toPluginInstallation(row.installation);
    if (installation) result.push({ installation, priority: row.priority, name: row.name, ...(row.kind ? { kind: row.kind } : {}) });
  }
  return result;
}

/**
 * Checkout's one plugin read: every active function registration and every
 * active payment provider registration, as one statement its read batch
 * carries. No app at either: no rows, and checkout does no app work.
 */
export function selectActiveCheckoutRegistrations(db: Database) {
  return db.select({
    kind: pluginRegistrations.kind,
    priority: pluginRegistrations.priority,
    name: pluginRegistrations.name,
    installation: pluginInstallations,
  })
    .from(pluginRegistrations)
    .innerJoin(pluginInstallations, eq(pluginInstallations.pluginId, pluginRegistrations.pluginId))
    .where(and(
      eq(pluginInstallations.status, "active"),
      or(
        eq(pluginRegistrations.kind, "function"),
        and(eq(pluginRegistrations.kind, "provider"), eq(pluginRegistrations.name, "payment")),
      ),
    ))
    .orderBy(asc(pluginRegistrations.priority), asc(pluginRegistrations.pluginId));
}

/** Active installations providing a port, by plugin id (one indexed read; none: no rows). */
export async function listActiveProviderPlugins(db: Database, kind: ProviderKind): Promise<PluginInstallation[]> {
  const rows = await activeRegistrations(db, "provider", [kind]);
  return rows.map((row) => row.installation).sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

/** Every active function registration (all points), by priority then plugin id. */
export async function listActiveFunctionRegistrations(db: Database): Promise<RegisteredPlugin[]> {
  return resolveActiveFunctionRegistrations(await selectActiveFunctionRegistrations(db).all());
}

/**
 * Approved plugins subscribed to a topic through its exact name, its
 * resource wildcard or `*` (one row per plugin), running or not: an app that
 * is stopped, failed or waiting for an update's approval keeps its events
 * as held deliveries (event-deliveries.ts), as event demand does.
 */
export async function listApprovedEventPlugins(db: Database, topic: string): Promise<RegisteredPlugin[]> {
  const prefix = topic.split(".", 1)[0];
  const rows = await db.select({ priority: pluginRegistrations.priority, name: pluginRegistrations.name, installation: pluginInstallations })
    .from(pluginRegistrations)
    .innerJoin(pluginInstallations, eq(pluginInstallations.pluginId, pluginRegistrations.pluginId))
    .where(and(
      eq(pluginRegistrations.kind, "event"),
      inArray(pluginRegistrations.name, [topic, `${prefix}.*`, "*"]),
      isNotNull(pluginInstallations.grantJson),
    ))
    .orderBy(asc(pluginRegistrations.priority), asc(pluginRegistrations.pluginId))
    .all();
  const seen = new Set<string>();
  const result: RegisteredPlugin[] = [];
  for (const row of rows) {
    if (seen.has(row.installation.pluginId)) continue;
    const installation = toPluginInstallation(row.installation);
    if (!installation) continue;
    seen.add(installation.pluginId);
    result.push({ installation, priority: row.priority, name: row.name });
  }
  return result;
}

/** Whether any approved plugin subscribes to any topic: the event pipeline's "nobody listens" check. */
export async function hasApprovedEventPlugins(db: Database): Promise<boolean> {
  const row = await db.select({ pluginId: pluginRegistrations.pluginId })
    .from(pluginRegistrations)
    .innerJoin(pluginInstallations, eq(pluginInstallations.pluginId, pluginRegistrations.pluginId))
    .where(and(eq(pluginRegistrations.kind, "event"), isNotNull(pluginInstallations.grantJson)))
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

/** `selectActiveCheckoutRegistrations`, run on its own and parsed (routes that read it in their first wave). */
export async function listActiveCheckoutRegistrations(db: Database): Promise<RegisteredPlugin[]> {
  return resolveActiveFunctionRegistrations(await selectActiveCheckoutRegistrations(db).all());
}
