// Data from removed apps (packages/plugin-sdk/docs/apps.md, "Uninstalling"):
// what an app that is no longer installed left in the store (any source,
// including a bundled app taken out of the deployment), by app, with the key
// it belongs to, and the Super Admin's two decisions for one app's group:
// "Delete data", or "Hand over data" to another key, for a release of the
// same app from another source or signer that is held until then (a signed
// upload moved into the store's own bundled code). Reinstalling the app with
// the same key reclaims its data instead. Registered before `/{id}` in apps.ts.
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { handOverRemovedAppData, listRemovedAppData } from "@scalius/core/modules/plugins";
import { PLUGIN_ID_PATTERN } from "@scalius/shared/plugins";
import { PLUGIN_KEY_ID } from "@scalius/shared/plugins/registry";
import { BUNDLED_PLUGINS } from "../../plugins/bundled.gen";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import { ForbiddenError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { deleteRemovedAppDataWithFiles } from "../../plugins/app-data";
import { syncBundledPlugin, syncBundledPlugins } from "../../plugins/bundled-sync";

const removedAppDataSchema = z.object({
  id: z.string().openapi({ description: "The removed app's id (vendor.name): the namespace of its object types and custom fields." }),
  name: z.string().openapi({ description: "The app's name when it was removed; its id when the store kept no record of the removal." }),
  removedAt: z.string().nullable().openapi({ description: "When it was uninstalled keeping its data; null when the store kept no record." }),
  revision: z.number().int().min(0).openapi({ description: "Send it back as expectedRevision to delete or hand over this data (0: the store kept no record of the removal)." }),
  signerKeyId: z.string().nullable().openapi({ description: "The key the data belongs to: the signer of the release that kept it (its fingerprint is this id in groups of four). null: unsigned or bundled code, or no record. Only a release signed with this key reclaims the data on its own." }),
  waitingRelease: z.object({
    source: z.literal("bundled"),
    version: z.string(),
    signerKeyId: z.null(),
  }).nullable().openapi({ description: "A release of this app in this deployment's own code that cannot install while the data belongs to another key. It installs once the data is deleted or handed over to it (signerKeyId null)." }),
  objectTypes: z.number().int(),
  records: z.number().int().openapi({ description: "Entries of its object types." }),
  objectTypeHandles: z.array(z.string()).openapi({ description: "Its object types the dashboard lists under Objects." }),
  customFields: z.number().int().openapi({ description: "Custom field definitions (their values go with them)." }),
  keyValues: z.number().int(),
  customerRoles: z.number().int().openapi({ description: "Roles it granted customers." }),
  jobs: z.number().int().openapi({ description: "Background job runs it kept." }),
  catalogItems: z.number().int().openapi({ description: "Catalogue items it created. They stay in the catalogue; those in the trash are deleted with the data unless the store must keep them." }),
  settings: z.boolean().openapi({ description: "Whether it kept settings that differ from the defaults (restored on reinstall)." }),
}).openapi("RemovedAppData");

const idParams = z.object({ id: z.string().regex(PLUGIN_ID_PATTERN).openapi({ description: "The removed app's id (vendor.name)." }) });

const isoOrNull = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toISOString() : null);

export function registerRemovedAppDataRoutes(app: OpenAPIHono<{ Bindings: Env }>): void {
  app.openapi(createRoute({
    method: "get",
    path: "/removed-data",
    operationId: "dashboard.apps.removed_data_list",
    tags: ["Admin - Apps"],
    summary: "Data left by apps that are no longer installed",
    description: "One group per app that is not installed but left object types, custom fields, key/value data, customer roles, jobs, catalogue ownership or settings. Reinstalling the app reclaims its group; dashboard.apps.removed_data_delete deletes it.",
    responses: {
      200: {
        description: "Removed apps' data",
        content: { "application/json": { schema: successEnvelope(z.object({ apps: z.array(removedAppDataSchema) })) } },
      },
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }), async (c) => {
    c.header("Cache-Control", "private, no-store");
    const db = c.get("db");
    // A bundled app in this deployment is installed, not removed.
    await syncBundledPlugins(db);
    const apps = (await listRemovedAppData(db)).map(({ pluginId, removedAt, ...entry }) => {
      // Still listed although this deployment bundles it: its sync was held by the data's owner key.
      const bundled = Object.prototype.hasOwnProperty.call(BUNDLED_PLUGINS, pluginId) ? BUNDLED_PLUGINS[pluginId]! : null;
      return {
        id: pluginId,
        ...entry,
        removedAt: isoOrNull(removedAt),
        waitingRelease: bundled && entry.signerKeyId !== null ? { source: "bundled" as const, version: bundled.version, signerKeyId: null } : null,
      };
    });
    return ok(c, { apps });
  });

  app.openapi(createRoute({
    method: "post",
    path: "/removed-data/{id}/delete",
    operationId: "dashboard.apps.removed_data_delete",
    tags: ["Admin - Apps"],
    summary: "Permanently delete a removed app's data",
    description: "Super Admin only. Permanently deletes what an app that is no longer installed left: its object types and their entries, custom fields and their values, key/value data, the roles it granted customers, its jobs, logs and delivery history, its kept settings and files. Catalogue items it created stay in the catalogue; those in the trash are permanently deleted unless the store must keep them (inventory history, orders, a file still shown). Cannot be undone: confirm in plain words first. Refused while the app is installed again, or when its data changed since the revision read.",
    request: {
      params: idParams,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              expectedRevision: z.number().int().min(0).openapi({ description: "The group's revision from dashboard.apps.removed_data_list." }),
            }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Deleted",
        content: {
          "application/json": {
            schema: successEnvelope(z.object({
              id: z.string(),
              deleted: z.literal(true),
              catalogDeleted: z.number().int().openapi({ description: "Trashed catalogue items it created that were permanently deleted." }),
              catalogKept: z.number().int().openapi({ description: "Trashed ones the store must keep; they stay in the trash." }),
            })),
          },
        },
      },
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      409: conflictResponse,
    },
  }), async (c) => {
    c.header("Cache-Control", "private, no-store");
    const actor = c.get("user") as { id?: string; isSuperAdmin?: boolean } | undefined;
    // An agent acts for its owner: it may delete only when that owner is a Super Admin. Apps never may.
    if (!actor?.id || actor.isSuperAdmin !== true || c.get("pluginPrincipal")) {
      throw new ForbiddenError("Only a Super Admin can delete a removed app's data.");
    }
    const { id } = c.req.valid("param");
    const { expectedRevision } = c.req.valid("json");
    const db = c.get("db");
    // A bundled app in this deployment installs here, and then owns its data.
    await syncBundledPlugin(db, id);
    const result = await deleteRemovedAppDataWithFiles(db, c.env, id, expectedRevision);
    return ok(c, { id, deleted: true as const, ...result });
  });

  app.openapi(createRoute({
    method: "post",
    path: "/removed-data/{id}/hand-over",
    operationId: "dashboard.apps.removed_data_hand_over",
    tags: ["Admin - Apps"],
    summary: "Hand a removed app's data over to another key",
    description: "Super Admin in the dashboard only (never an agent or an app). Data an uninstall kept belongs to the key that signed the release that kept it, and only that key's release reclaims it. This lets a release of the same app id with another key, or a move between a signed upload and the store's own bundled or unsigned code (signerKeyId null), reclaim everything listed, settings included: that release's code can then read and change it. A bundled release waiting for it installs at once. Refused while the app is installed, or when the group changed since the revision read.",
    request: {
      params: idParams,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              expectedRevision: z.number().int().min(0).openapi({ description: "The group's revision from dashboard.apps.removed_data_list." }),
              signerKeyId: z.string().regex(PLUGIN_KEY_ID).nullable().openapi({ description: "The key that may take the data: the waiting release's signer (the key id an upload refusal names as releaseSigner), or null for bundled or unsigned code." }),
            }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Handed over",
        content: {
          "application/json": {
            schema: successEnvelope(z.object({
              id: z.string(),
              revision: z.number().int().openapi({ description: "The group's new revision (0: the store kept no record, so any release reclaims it already)." }),
              installed: z.boolean().openapi({ description: "Whether a bundled release of this app was waiting and is now installed with the data." }),
            })),
          },
        },
      },
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      409: conflictResponse,
    },
  }), async (c) => {
    c.header("Cache-Control", "private, no-store");
    const actor = c.get("user") as { id?: string; isSuperAdmin?: boolean } | undefined;
    // Who may read an app's data is a trust decision, like trusting a developer key: a person's, in the dashboard.
    if (!actor?.id || actor.isSuperAdmin !== true || c.get("agentPrincipal") || c.get("pluginPrincipal")) {
      throw new ForbiddenError("Only a Super Admin in the dashboard can hand an app's data to another release.");
    }
    const { id } = c.req.valid("param");
    const { expectedRevision, signerKeyId } = c.req.valid("json");
    const db = c.get("db");
    const { revision } = await handOverRemovedAppData(db, id, { expectedRevision, signerKeyId });
    // A bundled release held by the data's owner key installs now, with the data.
    const installed = signerKeyId === null && (await syncBundledPlugin(db, id)) !== null;
    return ok(c, { id, revision, installed });
  });
}
