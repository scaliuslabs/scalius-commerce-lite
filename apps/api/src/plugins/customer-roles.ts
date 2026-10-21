// App-defined customer roles (`plugin_customer_roles`, migration 0171;
// @scalius/shared/plugins/customer-roles): the bridge's grant, revoke and
// list for one app (`ctx.customers.roles`), the proxied request's roles
// (`request.customer.roles`) and the per-app roles of checkout functions
// (`cart.customer.roles`). Every read and write is scoped to one plugin id:
// an app never sees or changes another app's rows.
//
// A grant is one guarded batch: the customer is live and the app holds fewer
// than PLUGIN_CUSTOMER_ROLES_MAX other roles on them, then the upsert, so two
// concurrent grants can never pass the cap together.
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { customers, pluginCustomerRoles } from "@scalius/database/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { PluginError } from "@scalius/core/modules/plugins";
import {
  PLUGIN_CUSTOMER_ROLE_PATTERN,
  PLUGIN_CUSTOMER_ROLE_REF_PATTERN,
  PLUGIN_CUSTOMER_ROLES_MAX,
  type PluginCustomerRole,
  type PluginCustomerRoleGrant,
} from "@scalius/shared/plugins/customer-roles";

const ROLE_GRANT_GUARD = "PLUGIN_CUSTOMER_ROLE_GRANT";

function customerIdOf(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new PluginError("customers_invalid", "customerId is a customer id.");
  }
  return value;
}

function roleOf(value: unknown): string {
  if (typeof value !== "string" || !PLUGIN_CUSTOMER_ROLE_PATTERN.test(value)) {
    throw new PluginError("customers_invalid", "role is a lower-case letter, then up to 31 lower-case letters, digits, _ or -.");
  }
  return value;
}

function refOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !PLUGIN_CUSTOMER_ROLE_REF_PATTERN.test(value)) {
    throw new PluginError("customers_invalid", "ref is 1 to 128 printable characters.");
  }
  return value;
}

async function liveCustomer(db: Database, customerId: string): Promise<boolean> {
  const row = await db.select({ id: customers.id }).from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.deletedAt))).get();
  return row !== undefined;
}

/** Grants `role` (re-granting updates `ref`): refuses a missing or deleted customer and an app at its cap. */
export async function grantPluginCustomerRole(db: Database, pluginId: string, customerIdInput: unknown, roleInput: unknown, refInput: unknown): Promise<void> {
  const customerId = customerIdOf(customerIdInput);
  const role = roleOf(roleInput);
  const ref = refOf(refInput);
  try {
    await safeBatch(db, [
      buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${customers} WHERE ${customers.id} = ${customerId} AND ${customers.deletedAt} IS NULL)
        AND (SELECT count(*) FROM ${pluginCustomerRoles} WHERE ${pluginCustomerRoles.pluginId} = ${pluginId}
          AND ${pluginCustomerRoles.customerId} = ${customerId} AND ${pluginCustomerRoles.role} <> ${role}) < ${PLUGIN_CUSTOMER_ROLES_MAX}`, ROLE_GRANT_GUARD),
      db.insert(pluginCustomerRoles).values({ pluginId, customerId, role, ref })
        .onConflictDoUpdate({ target: [pluginCustomerRoles.pluginId, pluginCustomerRoles.customerId, pluginCustomerRoles.role], set: { ref } }),
    ] as never);
  } catch (error) {
    if (!isBatchGuardError(error, ROLE_GRANT_GUARD)) throw error;
    if (!(await liveCustomer(db, customerId))) throw new PluginError("customers_not_found", "The customer was not found.");
    throw new PluginError("customer_roles_limit", `An app gives one customer at most ${PLUGIN_CUSTOMER_ROLES_MAX} roles; revoke one first.`);
  }
}

/** Removes `role` from the customer; nothing to remove is not an error. */
export async function revokePluginCustomerRole(db: Database, pluginId: string, customerIdInput: unknown, roleInput: unknown): Promise<void> {
  const customerId = customerIdOf(customerIdInput);
  const role = roleOf(roleInput);
  await db.delete(pluginCustomerRoles).where(and(
    eq(pluginCustomerRoles.pluginId, pluginId),
    eq(pluginCustomerRoles.customerId, customerId),
    eq(pluginCustomerRoles.role, role),
  ));
}

/** The app's roles on one customer, by role (one primary-key prefix read). */
export async function listPluginCustomerRoles(db: Database, pluginId: string, customerIdInput: unknown): Promise<PluginCustomerRoleGrant[]> {
  const customerId = customerIdOf(customerIdInput);
  const rows = await db.select({ role: pluginCustomerRoles.role, ref: pluginCustomerRoles.ref, grantedAt: pluginCustomerRoles.grantedAt })
    .from(pluginCustomerRoles)
    .where(and(eq(pluginCustomerRoles.pluginId, pluginId), eq(pluginCustomerRoles.customerId, customerId)))
    .orderBy(asc(pluginCustomerRoles.role));
  return rows.map((row) => ({ role: row.role, ref: row.ref, grantedAt: new Date(Number(row.grantedAt) * 1000).toISOString() }));
}

/** The app's roles on one customer as a request or function sees them: `{ role, ref }`, by role. */
export async function pluginCustomerRolesOf(db: Database, pluginId: string, customerId: string): Promise<PluginCustomerRole[]> {
  const rows = await db.select({ role: pluginCustomerRoles.role, ref: pluginCustomerRoles.ref })
    .from(pluginCustomerRoles)
    .where(and(eq(pluginCustomerRoles.pluginId, pluginId), eq(pluginCustomerRoles.customerId, customerId)))
    .orderBy(asc(pluginCustomerRoles.role));
  return rows.map((row) => ({ role: row.role, ref: row.ref }));
}

/**
 * One customer's roles from several apps in one read (the customer index),
 * by app id: what checkout functions get, each app only its own.
 */
export async function pluginCustomerRolesByApp(db: Database, customerId: string, pluginIds: readonly string[]): Promise<Map<string, PluginCustomerRole[]>> {
  const byApp = new Map<string, PluginCustomerRole[]>(pluginIds.map((id) => [id, []]));
  if (pluginIds.length === 0) return byApp;
  const rows = await db.select({ pluginId: pluginCustomerRoles.pluginId, role: pluginCustomerRoles.role, ref: pluginCustomerRoles.ref })
    .from(pluginCustomerRoles)
    .where(and(
      eq(pluginCustomerRoles.customerId, customerId),
      sql`${pluginCustomerRoles.pluginId} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(pluginIds)])}))`,
    ))
    .orderBy(asc(pluginCustomerRoles.pluginId), asc(pluginCustomerRoles.role));
  for (const row of rows) byApp.get(row.pluginId)?.push({ role: row.role, ref: row.ref });
  return byApp;
}
