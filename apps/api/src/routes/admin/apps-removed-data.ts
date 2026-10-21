// Data from removed apps (docs/platform/PLUGINS.md, "Uninstalling"): what an
// app that is no longer installed left in the store (any source, including a
// bundled app taken out of the deployment), by app, and the Super Admin's
// "Delete data" for one app's group. Reinstalling the app reclaims its data
// instead. Registered before `/{id}` in apps.ts.
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { listRemovedAppData } from "@scalius/core/modules/plugins";
import { PLUGIN_ID_PATTERN } from "@scalius/shared/plugins";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import { ForbiddenError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { deleteRemovedAppDataWithFiles } from "../../plugins/app-data";
import { syncBundledPlugin, syncBundledPlugins } from "../../plugins/bundled-sync";

const removedAppDataSchema = z.object({
  id: z.string().openapi({ description: "The removed app's id (vendor.name): the namespace of its object types and custom fields." }),
  name: z.string().openapi({ description: "The app's name when it was removed; its id when the store kept no record of the removal." }),
  removedAt: z.string().nullable().openapi({ description: "When it was uninstalled keeping its data; null when the store kept no record." }),
  revision: z.number().int().min(0).openapi({ description: "Send it back as expectedRevision to delete this data (0: the store kept no record of the removal)." }),
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
    const apps = (await listRemovedAppData(db)).map(({ pluginId, removedAt, ...entry }) => ({
      id: pluginId,
      ...entry,
      removedAt: isoOrNull(removedAt),
    }));
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
}
