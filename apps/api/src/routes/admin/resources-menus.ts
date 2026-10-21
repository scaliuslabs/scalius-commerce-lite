// Menu writes in the stable app API (operation-registry/README.md), mounted
// at /admin/resources (/menus): an app (a theme's onboarding, a demo store)
// creates a menu with all its links in one call, replaces its links under the
// revision it read, and publishes it. The dashboard's own menu editor works
// item by item (`dashboard.navigation.*`, beta). The Sensitive
// `write_navigation` scope confers `settings.header.edit`.
//
//   - Links are a flat list in tree order: each names its parent by the key
//     the caller gave it (`parentKey`), siblings in list order, at most three
//     levels and 150 links (the most a header or footer draws).
//   - A link to a category or collection may name it by handle
//     (`{ type: "resource", resourceType: "collection", handle: "hot-deals" }`):
//     it resolves to the id when written; an unknown handle refuses the write.
//   - `publish: true` publishes the saved revision in the same call. Publishing
//     checks every linked page, category, collection and product is ready; a
//     refused publish leaves the saved links unpublished and says why
//     (`published: false`, `publishError`). Where a published menu shows
//     (header, footer columns) stays the merchant's choice.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  NAVIGATION_MENU_WRITE_ITEM_LIMIT,
  createNavigationMenuWithItems,
  findNavigationMenu,
  publishNavigationMenu,
  readNavigationMenuTree,
  replaceNavigationMenu,
  type NavigationMenuTreeItem,
} from "@scalius/core/modules/navigation";
import { readThemeHandleLookup } from "@scalius/core/modules/storefront";
import { HANDLE_PATTERN } from "@scalius/shared/handle";
import { AppError } from "@scalius/core/errors";
import type { Database } from "@scalius/database/client";
import { created, ok } from "../../utils/api-response";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import { isoTimestampSchema, nullableIsoTimestampSchema } from "../../schemas/timestamps";
import { idempotencyKeyHeaderSchema } from "./idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

const SYSTEM_KEYS = ["home", "catalog", "search", "account", "cart", "checkout", "order_lookup"] as const;
const RESOURCE_TYPES = ["page", "category", "collection", "product"] as const;

const targetInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resource"),
    resourceType: z.enum(RESOURCE_TYPES),
    resourceId: z.string().trim().min(1).max(200).optional(),
    handle: z.string().trim().min(1).max(100).regex(HANDLE_PATTERN).optional()
      .openapi({ description: "A category's or collection's handle, instead of `resourceId`." }),
    query: z.string().max(1024).optional(),
  }).strict(),
  z.object({ type: z.literal("system"), key: z.enum(SYSTEM_KEYS) }).strict(),
  z.object({ type: z.literal("internal_path"), path: z.string().trim().min(1).max(2048) }).strict(),
  z.object({ type: z.literal("external_url"), url: z.string().trim().min(1).max(2048) }).strict(),
  z.object({ type: z.literal("label") }).strict(),
]).openapi("MenuLinkTargetInput");

const itemInput = z.object({
  key: z.string().trim().min(1).max(64).openapi({ description: "Your name for this link, unique in the request: children name it as `parentKey`." }),
  parentKey: z.string().trim().min(1).max(64).nullable().optional().openapi({ description: "The parent link's key (listed before it); omit for a top-level link." }),
  label: z.string().trim().min(1).max(100),
  labelMode: z.enum(["custom", "resource"]).default("custom").openapi({ description: "`resource` follows the linked resource's own title." }),
  target: targetInput,
  openInNewTab: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
}).strict().openapi("MenuLinkInput");

const itemsInput = z.array(itemInput).max(NAVIGATION_MENU_WRITE_ITEM_LIMIT).openapi({
  description: `All the menu's links in tree order (a parent before its children), at most ${NAVIGATION_MENU_WRITE_ITEM_LIMIT} and three levels.`,
});

const targetOutput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resource"), resourceType: z.enum(RESOURCE_TYPES), resourceId: z.string(), query: z.string().nullable() }),
  z.object({ type: z.literal("system"), key: z.string() }),
  z.object({ type: z.literal("internal_path"), path: z.string() }),
  z.object({ type: z.literal("external_url"), url: z.string() }),
  z.object({ type: z.literal("label") }),
]).openapi("MenuLinkTarget");

const menuSchema = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string(),
  revision: z.number().int().positive(),
  publishedRevision: z.number().int().positive().nullable(),
  trashed: z.boolean(),
  updatedAt: isoTimestampSchema,
  deletedAt: nullableIsoTimestampSchema,
  items: z.array(z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    label: z.string(),
    labelMode: z.enum(["custom", "resource"]),
    target: targetOutput,
    openInNewTab: z.boolean(),
    isEnabled: z.boolean(),
  })).max(NAVIGATION_MENU_WRITE_ITEM_LIMIT).nullable().openapi({
    description: `Its links in tree order; null when it holds more than ${NAVIGATION_MENU_WRITE_ITEM_LIMIT} (edit those in the dashboard).`,
  }),
}).openapi("MenuResource");

const publishOutcome = {
  published: z.boolean().openapi({ description: "Whether this call published the saved revision." }),
  publishError: z.object({ code: z.string(), message: z.string() }).nullable(),
};
const menuEnvelope = successEnvelope(z.object({ menu: menuSchema, ...publishOutcome }));

type ItemInput = z.infer<typeof itemInput>;

/** The links as the menu stores them, handles resolved; an unknown handle or a target missing its id refuses the write. */
async function treeItems(db: Database, items: readonly ItemInput[]): Promise<NavigationMenuTreeItem[]> {
  const named = items.flatMap((item) => (item.target.type === "resource" && item.target.handle ? [item.target] : []));
  const handleRefs = named.map((target) => {
    if (target.resourceType !== "category" && target.resourceType !== "collection") {
      throw new ValidationError("Only a category or collection link may name a handle; use resourceId.", { field: "target.handle" });
    }
    return target.resourceType === "category" ? `@category:${target.handle}` : `@collection:${target.handle}`;
  });
  const lookup = handleRefs.length > 0 ? await readThemeHandleLookup(db, [handleRefs]) : null;
  return items.map((item, index) => {
    const { target } = item;
    if (target.type !== "resource") return { ...item, target } as NavigationMenuTreeItem;
    if ((target.resourceId === undefined) === (target.handle === undefined)) {
      throw new ValidationError(`items.${index}: give the link's resourceId or its handle.`, { field: `items.${index}.target` });
    }
    let resourceId = target.resourceId;
    if (target.handle) {
      resourceId = lookup?.({ kind: target.resourceType as "category" | "collection", handle: target.handle }) ?? undefined;
      if (!resourceId) throw new AppError(422, "handle_unresolved", `items.${index}: no ${target.resourceType} has the handle ${target.handle}.`);
    }
    return {
      key: item.key,
      parentKey: item.parentKey ?? null,
      label: item.label,
      labelMode: item.labelMode,
      openInNewTab: item.openInNewTab,
      isEnabled: item.isEnabled,
      target: { type: "resource", resourceType: target.resourceType, resourceId: resourceId!, ...(target.query ? { query: target.query } : {}) },
    };
  });
}

type MenuRow = NonNullable<Awaited<ReturnType<typeof findNavigationMenu>>>;
type TreeRow = NonNullable<Awaited<ReturnType<typeof readNavigationMenuTree>>>[number];

function presentTarget(row: TreeRow): z.infer<typeof targetOutput> {
  switch (row.targetType) {
    case "page":
    case "category":
    case "collection":
    case "product":
      return { type: "resource", resourceType: row.targetType, resourceId: row.targetId ?? "", query: row.targetQuery ?? null };
    case "system":
      return { type: "system", key: row.targetValue ?? "home" };
    case "internal_path":
      return { type: "internal_path", path: row.targetValue ?? "/" };
    case "external_url":
      return { type: "external_url", url: row.targetValue ?? "" };
    default:
      return { type: "label" };
  }
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

async function presentMenu(db: Database, menu: MenuRow): Promise<z.infer<typeof menuSchema>> {
  const rows = await readNavigationMenuTree(db, menu.id);
  return {
    id: menu.id,
    name: menu.name,
    handle: menu.handle,
    revision: menu.revision,
    publishedRevision: menu.publishedRevision ?? null,
    trashed: menu.deletedAt !== null,
    updatedAt: menu.updatedAt.toISOString(),
    deletedAt: iso(menu.deletedAt),
    items: rows ? rows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      label: row.label,
      labelMode: row.labelMode,
      target: presentTarget(row),
      openInNewTab: row.openInNewTab,
      isEnabled: row.isEnabled,
    })) : null,
  };
}

function actorOf(c: Context): string | null {
  const user = c.get("user" as never) as { id?: string } | undefined;
  return user?.id ?? null;
}

/** Publishes the saved revision when asked; a refusal is the answer's, not the call's (the links stay saved). */
async function publishIfAsked(c: Context, db: Database, menuId: string, revision: number, publish: boolean) {
  if (!publish) return { published: false, publishError: null };
  try {
    await publishNavigationMenu(db, menuId, { expectedRevision: revision, publishedBy: actorOf(c) });
    return { published: true, publishError: null };
  } catch (error) {
    if (error instanceof AppError && error.status < 500) {
      return { published: false, publishError: { code: error.code, message: error.message.slice(0, 300) } };
    }
    throw error;
  }
}

async function menuOrNotFound(db: Database, idOrHandle: string): Promise<MenuRow> {
  const menu = await findNavigationMenu(db, idOrHandle);
  if (!menu) throw new NotFoundError("Menu not found.");
  return menu;
}

const menuParams = z.object({
  menu: z.string().trim().min(1).max(200).openapi({ description: "The menu's id, or the handle of a menu not in the trash." }),
});

// ── menus.get ──

app.openapi(createRoute({
  operationId: "dashboard.resources.menus.get",
  method: "get",
  path: "/menus/{menu}",
  tags: ["App API - Menus"],
  summary: "Read a menu and its links by id or handle",
  request: { params: menuParams },
  responses: {
    200: { description: "The menu", content: { "application/json": { schema: successEnvelope(z.object({ menu: menuSchema })) } } },
    ...errorResponses,
  },
}), async (c) => {
  const db = c.get("db");
  return ok(c, { menu: await presentMenu(db, await menuOrNotFound(db, c.req.valid("param").menu)) });
});

// ── menus.create ──

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  handle: z.string().trim().min(1).max(80).optional().openapi({ description: "Omit to derive it from the name; another live menu's handle is refused with 409." }),
  items: itemsInput.default([]),
  publish: z.boolean().default(false).openapi({ description: "Publish the new menu in the same call." }),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.menus.create",
  method: "post",
  path: "/menus",
  tags: ["App API - Menus"],
  summary: "Create a menu with all its links",
  description: "Creates the menu and its links in one write, and publishes it when `publish` is true. Send an Idempotency-Key: a repeat returns the first menu.",
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: { description: "The menu", content: { "application/json": { schema: menuEnvelope } } },
    409: conflictResponse,
    ...errorResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const items = await treeItems(db, body.items);
  const menu = await createNavigationMenuWithItems(db, { name: body.name, handle: body.handle, items });
  const outcome = await publishIfAsked(c, db, menu.id, menu.revision, body.publish);
  return created(c, { menu: await presentMenu(db, await menuOrNotFound(db, menu.id)), ...outcome });
});

// ── menus.update ──

const updateBody = z.object({
  expectedRevision: z.number().int().positive().openapi({ description: "The menu's `revision` you read; a menu changed since is refused with 409 and nothing is saved." }),
  name: z.string().trim().min(1).max(100).optional(),
  handle: z.string().trim().min(1).max(80).optional(),
  items: itemsInput.optional().openapi({ description: "When given, all the menu's links: they replace the current ones." }),
  publish: z.boolean().default(false).openapi({ description: "Publish the saved revision in the same call." }),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.menus.update",
  method: "patch",
  path: "/menus/{menu}",
  tags: ["App API - Menus"],
  summary: "Rename a menu or replace its links under the revision you read, and publish it",
  description: "One write that advances the revision once: the name and handle when given, and all the links when `items` is given. With nothing to change and `publish: true`, publishes the current revision.",
  request: {
    params: menuParams,
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { "application/json": { schema: updateBody } } },
  },
  responses: {
    200: { description: "The menu", content: { "application/json": { schema: menuEnvelope } } },
    409: conflictResponse,
    ...errorResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const menu = await menuOrNotFound(db, c.req.valid("param").menu);
  if (menu.deletedAt) throw new AppError(409, "menu_in_trash", "Restore this menu before changing it.");
  const changes = body.name !== undefined || body.handle !== undefined || body.items !== undefined;
  if (!changes && !body.publish) throw new ValidationError("Send a name, a handle, items or publish.");
  let revision = menu.revision;
  if (changes) {
    const items = body.items === undefined ? undefined : await treeItems(db, body.items);
    ({ revision } = await replaceNavigationMenu(db, menu.id, { expectedRevision: body.expectedRevision, name: body.name, handle: body.handle, items }));
  } else if (menu.revision !== body.expectedRevision) {
    throw new AppError(409, "navigation_revision_conflict", "This menu changed since you read it. Read it again and retry.");
  }
  const outcome = await publishIfAsked(c, db, menu.id, revision, body.publish);
  return ok(c, { menu: await presentMenu(db, await menuOrNotFound(db, menu.id)), ...outcome });
});

export { app as adminResourceMenuRoutes };
