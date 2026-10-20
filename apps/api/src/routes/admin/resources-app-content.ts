// Apps manage the catalogue content they created (operation-registry/README.md):
// `dashboard.resources.app_content.delete` permanently deletes trashed
// products, categories, brands, collections and media files that the calling
// app itself created. Ownership is the platform's record (`app_resource_owners`,
// written by `ctx.api.call` when the app's create succeeded), never the app's
// claim. Each item runs the staff permanent delete, so its rules hold: a
// product whose SKUs have inventory history or orders stays in the trash, and
// a file still shown somewhere stays. Plugins only; staff and agents use the
// per-resource permanent deletes.
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, inArray } from "drizzle-orm";
import {
  APP_OWNED_RESOURCE_TYPES,
  appResourceOwners,
  brands,
  categories,
  collections,
  media,
  products,
  type AppOwnedResourceType,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { permanentlyDeleteProduct } from "@scalius/core/modules/product-admin";
import { permanentlyDeleteCategory } from "@scalius/core/modules/categories";
import { permanentlyDeleteBrands } from "@scalius/core/modules/brands";
import { bulkDeleteCollections } from "@scalius/core/modules/collections";
import { permanentlyDeleteMediaFile } from "@scalius/core/modules/media";
import { ok } from "../../utils/api-response";
import { AppError } from "../../utils/api-error";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { idempotencyKeyHeaderSchema } from "./idempotency";

/** Items one call deletes: each is its own guarded write, so the bound keeps a call inside one invocation. */
export const APP_CONTENT_DELETE_MAX = 50;

/** The RBAC permission an app's grant needs for each type (write_products, write_files). */
const TYPE_PERMISSION: Record<AppOwnedResourceType, string> = {
  product: "products.delete",
  category: "categories.delete",
  brand: "categories.delete",
  collection: "collections.delete",
  media: "media.delete",
};

const itemSchema = z.object({
  type: z.enum(APP_OWNED_RESOURCE_TYPES),
  id: z.string().min(1).max(160),
  expectedRevision: z.number().int().min(1).optional().openapi({
    description: "The revision you read: a product's `aggregateRevision`, a category's or brand's `revision`, a file's `version`; a collection may leave it out. Required for every type but collections.",
  }),
}).strict();

const outcomeSchema = z.object({
  type: z.enum(APP_OWNED_RESOURCE_TYPES),
  id: z.string(),
  outcome: z.enum(["deleted", "not_found", "not_owned", "not_in_trash", "conflict", "blocked", "forbidden"]).openapi({
    description: "`deleted`; `not_found` (already gone); `not_owned` (the app did not create it); `not_in_trash` (trash it first); `conflict` (it changed since `expectedRevision`); `blocked` (inventory history, orders or a place still shows it: it stays in the trash); `forbidden` (the grant does not cover the type).",
  }),
  message: z.string().nullable(),
}).strict();

export type AppContentOutcome = z.infer<typeof outcomeSchema>;

/** Whether the item is in the trash: null when it does not exist. */
async function inTrash(db: Database, type: AppOwnedResourceType, id: string): Promise<boolean | null> {
  switch (type) {
    case "product": {
      const row = await db.select({ deletedAt: products.deletedAt }).from(products).where(eq(products.id, id)).get();
      return row ? row.deletedAt !== null : null;
    }
    case "category": {
      const row = await db.select({ deletedAt: categories.deletedAt }).from(categories).where(eq(categories.id, id)).get();
      return row ? row.deletedAt !== null : null;
    }
    case "brand": {
      const row = await db.select({ deletedAt: brands.deletedAt }).from(brands).where(eq(brands.id, id)).get();
      return row ? row.deletedAt !== null : null;
    }
    case "collection": {
      const row = await db.select({ deletedAt: collections.deletedAt }).from(collections).where(eq(collections.id, id)).get();
      return row ? row.deletedAt !== null : null;
    }
    case "media": {
      const row = await db.select({ status: media.status }).from(media).where(eq(media.id, id)).get();
      if (!row || row.status === "deleted") return null;
      return row.status === "trashed" || row.status === "deleting";
    }
  }
}

function errorOutcome(error: unknown): { outcome: AppContentOutcome["outcome"]; message: string } | null {
  if (!(error instanceof Error)) return null;
  const status = (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  const code = (error as { code?: unknown }).code;
  const message = error.message.slice(0, 300);
  if (status === 404) return { outcome: "not_found", message };
  if (status === 409 || status === 412) {
    // A revision mismatch is a conflict; a reference (inventory, orders, use) blocks.
    return /revision|version|changed/i.test(message) && !/inventory|order|in use|shows|used/i.test(message)
      ? { outcome: "conflict", message }
      : { outcome: "blocked", message };
  }
  if (status === 400 || status === 422 || typeof code === "string") return { outcome: "blocked", message };
  return null;
}

async function deleteOne(
  db: Database,
  env: Env,
  item: z.infer<typeof itemSchema>,
): Promise<void> {
  const revision = item.expectedRevision;
  if (item.type !== "collection" && revision === undefined) {
    throw new AppError(400, "validation_error", "Send expectedRevision for this item.");
  }
  switch (item.type) {
    case "product":
      return permanentlyDeleteProduct(db, item.id, revision!);
    case "category":
      return permanentlyDeleteCategory(db, item.id, revision!);
    case "brand":
      return permanentlyDeleteBrands(db, [{ id: item.id, expectedRevision: revision! }]);
    case "collection":
      await bulkDeleteCollections(db, [item.id], true);
      return;
    case "media":
      await permanentlyDeleteMediaFile(db, item.id, revision!, env.BUCKET);
      return;
  }
}

/** Deletes the app's own trashed items, one guarded write each, in the order given. */
export async function deleteAppContent(
  db: Database,
  env: Env,
  pluginId: string,
  permissions: ReadonlySet<string>,
  items: ReadonlyArray<z.infer<typeof itemSchema>>,
): Promise<AppContentOutcome[]> {
  const owned = new Set<string>();
  const ids = [...new Set(items.map((item) => item.id))];
  for (let index = 0; index < ids.length; index += 90) {
    const rows = await db.select({ type: appResourceOwners.resourceType, id: appResourceOwners.resourceId })
      .from(appResourceOwners)
      .where(and(eq(appResourceOwners.pluginId, pluginId), inArray(appResourceOwners.resourceId, ids.slice(index, index + 90))))
      .all();
    for (const row of rows) owned.add(`${row.type}:${row.id}`);
  }
  const outcomes: AppContentOutcome[] = [];
  for (const item of items) {
    const result = (outcome: AppContentOutcome["outcome"], message: string | null = null) =>
      outcomes.push({ type: item.type, id: item.id, outcome, message });
    if (!permissions.has(TYPE_PERMISSION[item.type])) { result("forbidden", "The app's grant does not cover this type."); continue; }
    if (!owned.has(`${item.type}:${item.id}`)) { result("not_owned"); continue; }
    const trashed = await inTrash(db, item.type, item.id);
    if (trashed === null) {
      await forget(db, item.type, item.id);
      result("not_found");
      continue;
    }
    if (!trashed) { result("not_in_trash", "Move it to the trash first."); continue; }
    try {
      await deleteOne(db, env, item);
      await forget(db, item.type, item.id);
      result("deleted");
    } catch (error) {
      const mapped = errorOutcome(error);
      if (!mapped) throw error;
      result(mapped.outcome, mapped.message);
    }
  }
  return outcomes;
}

function forget(db: Database, type: AppOwnedResourceType, id: string) {
  return db.delete(appResourceOwners)
    .where(and(eq(appResourceOwners.resourceType, type), eq(appResourceOwners.resourceId, id)))
    .run();
}

export function registerAppContentRoutes(app: OpenAPIHono<{ Bindings: Env }>): void {
  app.openapi(createRoute({
    operationId: "dashboard.resources.app_content.delete",
    method: "post",
    path: "/app-content/delete",
    tags: ["App API - Products"],
    summary: "Permanently delete trashed items the app created",
    description: `Apps only. Permanently deletes up to ${APP_CONTENT_DELETE_MAX} products, categories, brands, collections or media files that the calling app created and that are in the trash, each under the revision it was read at. Anything else is left as it is and named in the outcome: a staff-made or another app's item (\`not_owned\`), a live one (\`not_in_trash\`), a changed one (\`conflict\`), or one the store must keep (\`blocked\`: a product with inventory history or orders, a file still shown somewhere). Products need write_products, files write_files.`,
    request: {
      headers: idempotencyKeyHeaderSchema,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ items: z.array(itemSchema).min(1).max(APP_CONTENT_DELETE_MAX) }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "One outcome per item, in order",
        content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(outcomeSchema).max(APP_CONTENT_DELETE_MAX) })) } },
      },
      ...errorResponses,
    },
  }), async (c) => {
    const principal = c.get("pluginPrincipal") as { pluginId: string; permissions: ReadonlySet<string> } | undefined;
    if (!principal?.pluginId) {
      throw new AppError(403, "app_only", "Only an app deletes its own content here; staff use each resource's permanent delete.");
    }
    const { items } = c.req.valid("json");
    const outcomes = await deleteAppContent(c.get("db"), c.env, principal.pluginId, principal.permissions, items);
    return ok(c, { items: outcomes });
  });
}
