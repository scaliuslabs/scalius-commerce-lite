// What an app's own webhook subscriptions may do (operation-registry/README.md,
// `write_webhooks`): its live grant's approved hosts, event topics and
// protected customer data, read from the active installation. The routes check
// a subscription against it when the app writes one, and every delivery checks
// it again, so a narrowed, disabled or uninstalled app stops sending at once.
import type { Database } from "@scalius/database/client";
import type { AppWebhookAccess } from "@scalius/core/modules/events";
import { PROTECTED_CUSTOMER_DATA, grantedProtectedData } from "@scalius/shared/plugins/protected-data";

/** The scope that lets an app keep webhook subscriptions. */
export const APP_WEBHOOK_SCOPE = "write_webhooks";

/** The active app's webhook access, or null (not active, no grant, or no `write_webhooks`). */
export async function readAppWebhookAccess(db: Database, pluginId: string): Promise<AppWebhookAccess | null> {
  // Loaded on demand: the event drain reaches it only for an app-owned delivery.
  const { getActivePluginInstallation } = await import("@scalius/core/modules/plugins");
  const installation = await getActivePluginInstallation(db, pluginId);
  const grant = installation?.grant;
  if (!grant || !grant.scopes.includes(APP_WEBHOOK_SCOPE)) return null;
  const protectedData = grantedProtectedData(grant.scopes);
  return {
    allowedHosts: [...grant.allowedHosts],
    topics: [...grant.events],
    customerData: PROTECTED_CUSTOMER_DATA.filter((category) => protectedData.has(category)),
  };
}

/** One reader per dispatch run: each app's grant is read once however many deliveries it has. */
export function appWebhookAccessReader(db: Database): (pluginId: string) => Promise<AppWebhookAccess | null> {
  const seen = new Map<string, Promise<AppWebhookAccess | null>>();
  return (pluginId) => {
    let access = seen.get(pluginId);
    if (!access) {
      access = readAppWebhookAccess(db, pluginId);
      seen.set(pluginId, access);
    }
    return access;
  };
}
