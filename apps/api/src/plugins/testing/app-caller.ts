// A third-party (uploaded) app installed with the scopes a test names, and
// its `ctx.api.call` as production runs it: app name, stable tier, RBAC from
// the scopes, the admin middleware (Idempotency-Key replay included) and the
// route. The store's owner approves it.
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { activatePlugin, installPlugin } from "@scalius/core/modules/plugins";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import type { PluginScope } from "@scalius/shared/plugins/scopes";
import { callPluginOperation } from "../api-call";
import { pluginTestCtx, pluginTestEnv } from "./fixtures";

export function seedAppOwner(sqlite: DatabaseSync): void {
  sqlite.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
}

/** Installs and activates `id` with these scopes; answers its `ctx.api.call`. */
export async function installAppCaller(
  fixture: { db: Database; sqlite: DatabaseSync; binding: D1Database },
  id: string,
  scopes: PluginScope[],
) {
  seedAppOwner(fixture.sqlite);
  const manifest: PluginManifestInput = {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    description: "Calls the stable app API in a test.",
    author: { name: "Acme" },
    scopes,
  };
  await installPlugin(fixture.db, { manifest, source: "upload", bundleSha256: "c".repeat(64), actorUserId: "owner" });
  await activatePlugin(fixture.db, id, { actorUserId: "owner", expectedRevision: 1 });
  const env = pluginTestEnv(fixture.binding);
  return (operationId: string, input?: unknown) =>
    callPluginOperation({ pluginId: id, version: "1.0.0", operationId, input, db: fixture.db, env, ctx: pluginTestCtx() });
}
