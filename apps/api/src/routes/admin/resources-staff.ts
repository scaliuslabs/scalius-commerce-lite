// The staff directory in the stable app API (operation-registry/README.md),
// mounted at /admin/resources: who works at the store, by name and role, so
// an app attributes work (who rang up a point-of-sale sale, who packed an
// order). `staff.list` and `staff.get` need `staff.view` (an app:
// `read_staff`), which is outside the team area: it never reaches the team's
// own routes.
//
// A staff member answers `StaffMemberResource`: id, name, whether they are
// the store owner, their roles, whether they are active, and when the record
// was made and last changed. Never an email, a phone, sign-in, session or
// two-step facts, permissions or overrides: an app that knows who did
// something learns nothing about how to sign in as them or what they may do.
//
// Every `user` row is a dashboard identity (sign-up is closed: staff come
// only from setup, an invitation or the identity handoff), so the directory
// is the whole table. A removed staff member keeps their row so history
// keeps their name (`removeStaffMember`); they list as inactive with no
// roles, like a suspended one. Lists page by cursor in (updatedAt, id)
// order; a role assigned or removed advances the person's `updatedAt`
// (`assignRoleToUser`, `removeRoleFromUser`), so `updatedSince` sees it. The
// table holds staff only (tens to hundreds of rows), so its walk needs no
// index of its own.
import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "./admin-router";
import type { MiddlewareHandler } from "hono";
import { eq, sql, type SQL } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import { roles, user, userRoles } from "@scalius/database/schema";
import { keysetOrderBy } from "@scalius/core/utils/keyset";
import { inJsonArray } from "@scalius/core/utils/in-json-array";
import { ok } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";
import { errorResponses, successEnvelope } from "../../schemas/responses";
import { isoTimestampSchema } from "../../schemas/timestamps";
import { nextCursorSchema } from "../../utils/bounded-page";
import { epochSeconds, resourcePage, resourcePageQuery, updatedOrder } from "../../utils/resource-page";

const app = adminRouter();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };

const StaffMemberResource = z.object({
  id: z.string(),
  name: z.string().openapi({ description: "The name the dashboard shows for them (on the order timeline, beside stock movements)." }),
  isOwner: z.boolean().openapi({ description: "The store owner: they hold every permission and cannot be removed." }),
  active: z.boolean().openapi({ description: "False while they are suspended, and for good once removed from staff; a removed member keeps their name for history." }),
  roles: z.array(z.object({
    id: z.string(),
    name: z.string().openapi({ description: "The role's key, such as `manager` or `sales_rep`; a custom role's own." }),
    displayName: z.string(),
  })).openapi({ description: "Their roles, by display name. The owner needs none; a removed member has none." }),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema.openapi({ description: "When the record last changed, a role assigned or removed included." }),
}).openapi("StaffMemberResource");

type StaffMember = z.infer<typeof StaffMemberResource>;

const iso = (value: Date | null): string => (value ?? new Date(0)).toISOString();

/**
 * The name an app reads: the stored name, except that a name holding an `@`
 * (an identity handoff with no name claim names the person by their
 * address) reads as the part before it, so the directory never carries an
 * email address.
 */
function staffDisplayName(name: string): string {
  const at = name.indexOf("@");
  return at < 0 ? name : name.slice(0, at);
}

/** Active: not suspended now (a suspension with an end that has passed is over) and not removed. */
function activeCondition(nowSeconds: number): SQL {
  return sql`(${user.banned} = 0 OR (${user.banExpires} IS NOT NULL AND ${user.banExpires} <= ${nowSeconds}))`;
}

/** The staff members with these ids, in the order given, each with their roles: two reads in one batch. */
async function readStaffMembers(db: Database, ids: readonly string[]): Promise<StaffMember[]> {
  if (ids.length === 0) return [];
  const [people = [], assigned = []] = await safeBatch(db, [
    db.select({
      id: user.id,
      name: user.name,
      isSuperAdmin: user.isSuperAdmin,
      banned: user.banned,
      banExpires: user.banExpires,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }).from(user).where(inJsonArray(user.id, ids)),
    db.select({ userId: userRoles.userId, id: roles.id, name: roles.name, displayName: roles.displayName })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(inJsonArray(userRoles.userId, ids))
      .orderBy(roles.displayName, roles.id),
  ] as const);
  const rolesOf = new Map<string, StaffMember["roles"]>();
  for (const row of assigned) {
    const list = rolesOf.get(row.userId) ?? [];
    list.push({ id: row.id, name: row.name, displayName: row.displayName });
    rolesOf.set(row.userId, list);
  }
  const nowMs = Date.now();
  const byId = new Map(people.map((person) => [person.id, {
    id: person.id,
    name: staffDisplayName(person.name),
    isOwner: person.isSuperAdmin,
    active: !person.banned || (person.banExpires !== null && person.banExpires.getTime() <= nowMs),
    roles: rolesOf.get(person.id) ?? [],
    createdAt: iso(person.createdAt),
    updatedAt: iso(person.updatedAt),
  } satisfies StaffMember]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

app.openapi(createRoute({
  operationId: "dashboard.resources.staff.list",
  method: "get",
  path: "/staff",
  tags: ["App API - Staff"],
  summary: "List staff members, least recently updated first",
  description: "The staff directory (StaffMemberResource: name, roles, whether they are the owner and active), in (updatedAt, id) order, removed members included as inactive so past work keeps its name. Filter by `active`; start a sync with updatedSince and follow nextCursor. Never an email, a phone, sign-in facts or permissions.",
  request: {
    query: z.object({
      ...resourcePageQuery,
      active: z.enum(["true", "false"]).optional().openapi({ description: "`true`: only staff who can work now; `false`: only suspended and removed ones. Omitted: everyone." }),
    }),
  },
  responses: {
    200: { description: "A page of staff members", content: { "application/json": { schema: successEnvelope(z.object({ staffMembers: z.array(StaffMemberResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.active) {
    const active = activeCondition(Math.floor(Date.now() / 1000));
    where.push(query.active === "true" ? active : sql`NOT ${active}`);
  }
  if (query.updatedSince) where.push(sql`${user.updatedAt} >= ${epochSeconds(query.updatedSince)}`);
  const order = updatedOrder(user.updatedAt, user.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: user.id }).from(user).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readStaffMembers(db, ids),
  });
  return ok(c, { staffMembers: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.staff.get",
  method: "get",
  path: "/staff/{id}",
  tags: ["App API - Staff"],
  summary: "Get a staff member",
  description: "One staff member by id (an order timeline's or a stock movement's staff id), removed ones included: name, roles, whether they are the owner and active.",
  request: { params: z.object({ id: z.string().min(1).max(100) }) },
  responses: {
    200: { description: "The staff member", content: { "application/json": { schema: successEnvelope(z.object({ staffMember: StaffMemberResource })) } } },
    ...readResponses,
  },
}), async (c) => {
  const [staffMember] = await readStaffMembers(c.get("db"), [c.req.valid("param").id]);
  if (!staffMember) throw new NotFoundError("Staff member not found");
  return ok(c, { staffMember });
});

export { app as adminResourceStaffRoutes };
