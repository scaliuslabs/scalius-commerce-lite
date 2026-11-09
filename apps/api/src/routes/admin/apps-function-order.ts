// Checkout order (packages/plugin-sdk/docs/apps.md, "Checkout order"): which
// apps run at each checkout function point, in the order checkout runs and
// merges them, how their answers combine there, and the merchant's way to
// reorder them (core plugins/function-order.ts). Registered before `/{id}`
// in apps.ts.
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import {
  functionPointOrders,
  listPluginInstallations,
  setFunctionPointOrder,
  type FunctionPointOrder,
} from "@scalius/core/modules/plugins";
import { PLUGIN_FUNCTION_POINTS, PLUGIN_ID_PATTERN } from "@scalius/shared/plugins";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { syncBundledPlugins } from "../../plugins/bundled-sync";

const functionPointAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int().openapi({ description: "The app's own priority for this point (its manifest): the order when the merchant set none." }),
  rank: z.number().int().nullable().openapi({ description: "The merchant's place for the app here (0 first); null when the app's priority places it, after the ranked apps." }),
  runs: z.boolean().openapi({ description: "Whether the app runs at checkout now (active and approved for this point). An app that does not run keeps its place." }),
  blocking: z.boolean().openapi({ description: "Whether checkout refuses orders when this app cannot answer here (approved as blocking)." }),
});

const functionPointOrderSchema = z.object({
  point: z.enum(PLUGIN_FUNCTION_POINTS),
  composition: z.enum(["first", "all", "stack", "sequence"]).openapi({
    description: "How the apps' answers combine here, in this order. first: the first app that decides an item (a line's price, a line's bundle) wins it. all: every app's answer applies (any rule error blocks). stack: discounts in order, each from what the ones before left. sequence: operations in order, a later one over an earlier; a hide always wins.",
  }),
  ordered: z.boolean().openapi({ description: "Whether the merchant set this order (false: the apps' own priorities decide)." }),
  revision: z.string().openapi({ description: "This order as read: send it back as expectedRevision when saving the point. It changes with every save, install or removal at the point." }),
  winner: z.string().nullable().openapi({ description: "Where the first app wins (composition first) and more than one app runs: the app whose decision wins when apps overlap. null otherwise." }),
  apps: z.array(functionPointAppSchema).openapi({ description: "Every installed app implementing the point, in the order checkout runs and merges them." }),
}).openapi("AppFunctionPointOrder");

function present(order: FunctionPointOrder): z.infer<typeof functionPointOrderSchema> {
  const running = order.apps.filter((entry) => entry.runs);
  return {
    point: order.point,
    composition: order.composition,
    ordered: order.ordered,
    revision: order.revision,
    winner: order.composition === "first" && running.length > 1 ? running[0]!.installation.pluginId : null,
    apps: order.apps.map((entry) => ({
      id: entry.installation.pluginId,
      name: entry.installation.manifest.name,
      priority: entry.priority,
      rank: entry.rank,
      runs: entry.runs,
      blocking: entry.installation.manifest.functions.some((fn) => fn.point === order.point && fn.onError === "block")
        && Boolean(entry.installation.grant?.blockingFunctions.some((point) => point === order.point)),
    })),
  };
}

export function registerFunctionOrderRoutes(app: OpenAPIHono<{ Bindings: Env }>): void {
  app.openapi(createRoute({
    method: "get",
    path: "/function-order",
    operationId: "dashboard.apps.function_order_get",
    tags: ["Admin - Apps"],
    summary: "The order apps run in at each checkout function point",
    description: "Every checkout function point at least one installed app implements, its apps in the order checkout runs and merges them, and how their answers combine there.",
    responses: {
      200: {
        description: "The checkout order",
        content: { "application/json": { schema: successEnvelope(z.object({ points: z.array(functionPointOrderSchema) })) } },
      },
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }), async (c) => {
    c.header("Cache-Control", "no-store");
    const db = c.get("db");
    await syncBundledPlugins(db);
    return ok(c, { points: functionPointOrders(await listPluginInstallations(db)).map(present) });
  });

  app.openapi(createRoute({
    method: "put",
    path: "/function-order",
    operationId: "dashboard.apps.function_order_update",
    tags: ["Admin - Apps"],
    summary: "Set the order apps run in at one checkout function point",
    description: "appIds names every installed app implementing the point, once each, first to run first; null resets the point to the apps' own priorities. expectedRevision is the point's revision the save started from. Apps installed later run after the ordered ones until placed. 409 when the apps at the point changed, or the order changed since expectedRevision was read (another tab or merchant saved first): reload and try again.",
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              point: z.enum(PLUGIN_FUNCTION_POINTS),
              appIds: z.array(z.string().regex(PLUGIN_ID_PATTERN)).max(100).nullable(),
              expectedRevision: z.string().max(10_000).openapi({ description: "The point's revision as read (GET /function-order)." }),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: successEnvelope(z.object({ point: functionPointOrderSchema })) } } },
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      409: conflictResponse,
    },
  }), async (c) => {
    c.header("Cache-Control", "no-store");
    const body = c.req.valid("json");
    const saved = await setFunctionPointOrder(c.get("db"), body.point, body.appIds, body.expectedRevision);
    return ok(c, { point: present(saved) });
  });
}
