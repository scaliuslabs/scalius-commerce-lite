// Admin custom field routes (COMMERCE-HOOKS H4) on the migrated schema:
// definition CRUD under revisions, per-owner value reads and all-or-nothing
// batch writes, the merchant namespace guard, and the RBAC map that ties each
// owner's values to its own permission family.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createCustomFieldDefinition, createCustomFieldDefinitionSchema } from "@scalius/core/modules/custom-fields";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { hasPageAccess } from "@scalius/core/auth/rbac/page-permissions";
import { CUSTOM_FIELD_OWNER_TYPES } from "@scalius/shared/custom-fields";

import { errorResponseFromError } from "../../utils/api-response";
import { classifyAdminRuntimePath } from "../../runtime/admin-app";
import { customFieldDefinitionRoutes, customFieldValueRoutes } from "./custom-fields";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('prod_a', 'Panjabi', 100000, 'panjabi', 1);
    INSERT INTO customers (id, name, phone) VALUES ('cus_a', 'Buyer', '01711000000');
  `);
});
afterEach(() => sqlite.close());

function app() {
  const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  router.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  router.route("/custom-field-definitions", customFieldDefinitionRoutes);
  router.route("/custom-fields", customFieldValueRoutes);
  router.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  return router;
}

async function call(method: string, path: string, body?: unknown) {
  const response = await app().request(`/api/v1/admin${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON body freely
  return { status: response.status, body: await response.json() as { data: any; error: { code: string; message: string; details?: any } } };
}

describe("custom field definition routes", () => {
  it("creates, lists, edits under the revision, reorders and deletes", async () => {
    const care = await call("POST", "/custom-field-definitions", { ownerType: "product", name: "Care guide", type: "multi_line_text", storefrontVisible: true });
    expect(care.status).toBe(201);
    expect(care.body.data.definition).toMatchObject({ key: "care_guide", namespace: "custom", revision: 1, position: 0 });
    const msrp = await call("POST", "/custom-field-definitions", { ownerType: "product", name: "MSRP", type: "money", validations: { min: 100 } });
    // Money bounds are integer minor units of the store currency.
    expect(msrp.body.data.definition.validations).toEqual({ min: 100, max: null, regex: null, choices: null });
    expect((await call("POST", "/custom-field-definitions", { ownerType: "product", name: "Floor", type: "money", validations: { min: 1.5 } })).status).toBe(400);

    const taken = await call("POST", "/custom-field-definitions", { ownerType: "product", name: "Other", key: "care_guide", type: "url" });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("custom_field_key_taken");
    const badType = await call("POST", "/custom-field-definitions", { ownerType: "product", name: "Flags", type: "list.boolean" });
    expect(badType.status).toBe(400);
    const pluginNamespace = await call("POST", "/custom-field-definitions", { ownerType: "product", name: "Points", namespace: "acme.loyalty", type: "integer" });
    expect(pluginNamespace.status).toBe(403);
    expect(pluginNamespace.body.error.code).toBe("custom_field_namespace_forbidden");

    const id = care.body.data.definition.id as string;
    const edited = await call("PATCH", `/custom-field-definitions/${id}`, { expectedRevision: 1, name: "Care" });
    expect(edited.body.data.definition).toMatchObject({ name: "Care", revision: 2 });
    const stale = await call("PATCH", `/custom-field-definitions/${id}`, { expectedRevision: 1, name: "Late" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("custom_field_revision_conflict");

    const list = await call("GET", "/custom-field-definitions?ownerType=product");
    expect(list.body.data.definitions.map((definition: { key: string }) => definition.key)).toEqual(["care_guide", "msrp"]);
    const reordered = await call("POST", "/custom-field-definitions/reorder", {
      ownerType: "product",
      definitions: [
        { id: msrp.body.data.definition.id, expectedRevision: 1 },
        { id, expectedRevision: 2 },
      ],
    });
    expect(reordered.body.data.definitions.map((definition: { key: string }) => definition.key)).toEqual(["msrp", "care_guide"]);

    expect((await call("DELETE", `/custom-field-definitions/${id}?expectedRevision=2`)).status).toBe(409);
    const deleted = await call("DELETE", `/custom-field-definitions/${id}?expectedRevision=3`);
    expect(deleted.body.data).toEqual({ id, deletedValueCount: 0 });
    expect((await call("GET", `/custom-field-definitions/${id}`)).status).toBe(404);
  });
});

describe("custom field value routes", () => {
  it("reads every field of an owner and writes values in one all-or-nothing batch", async () => {
    const care = (await call("POST", "/custom-field-definitions", { ownerType: "product", name: "Care", type: "single_line_text", validations: { max: 10 } })).body.data.definition;
    const msrp = (await call("POST", "/custom-field-definitions", { ownerType: "product", name: "MSRP", type: "money" })).body.data.definition;

    const empty = await call("GET", "/custom-fields/product/prod_a");
    expect(empty.status).toBe(200);
    expect(empty.body.data.fields.map((field: { value: unknown }) => field.value)).toEqual([null, null]);

    const refused = await call("PUT", "/custom-fields/product/prod_a", {
      values: [{ definitionId: care.id, value: "Hand wash cold only" }, { definitionId: msrp.id, value: { amountMinor: 150000, currency: "BDT" } }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.issues).toEqual([expect.objectContaining({ path: ["values", 0, "value"], code: "too_long" })]);
    expect((await call("GET", "/custom-fields/product/prod_a")).body.data.fields[1].value).toBeNull();

    // Money is one format: a decimal or a bare number is refused.
    const decimal = await call("PUT", "/custom-fields/product/prod_a", { values: [{ definitionId: msrp.id, value: 1500 }] });
    expect(decimal.status).toBe(400);
    expect(decimal.body.error.details.issues).toEqual([expect.objectContaining({ path: ["values", 0, "value"], code: "invalid" })]);
    const saved = await call("PUT", "/custom-fields/product/prod_a", {
      values: [{ definitionId: care.id, value: "Hand wash" }, { definitionId: msrp.id, value: { amountMinor: 150000, currency: "BDT" } }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.fields.map((field: { value: unknown }) => field.value)).toEqual(["Hand wash", { amountMinor: 150000, currency: "BDT" }]);

    expect((await call("GET", "/custom-fields/product/prod_nope")).status).toBe(404);
    // Another owner type's route never reaches product fields.
    const wrongOwner = await call("PUT", "/custom-fields/customer/cus_a", { values: [{ definitionId: care.id, value: "x" }] });
    expect(wrongOwner.status).toBe(400);
  });

  it("refuses merchant writes to a plugin's namespace but shows its values", async () => {
    const points = await createCustomFieldDefinition(
      db,
      createCustomFieldDefinitionSchema.parse({ ownerType: "customer", name: "Points", type: "integer" }),
      { writer: { kind: "plugin", pluginId: "acme.loyalty" } },
    );
    const refused = await call("PUT", "/custom-fields/customer/cus_a", { values: [{ definitionId: points.id, value: 10 }] });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("custom_field_namespace_forbidden");
    const read = await call("GET", "/custom-fields/customer/cus_a");
    expect(read.body.data.fields).toEqual([expect.objectContaining({ definition: expect.objectContaining({ namespace: "acme.loyalty" }), value: null })]);
  });
});

describe("custom field RBAC", () => {
  it("maps definitions to settings and each owner's values to its own permission family", () => {
    expect(getRoutePermission("/api/v1/admin/custom-field-definitions", "GET")).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_VIEW });
    expect(getRoutePermission("/api/v1/admin/custom-field-definitions", "POST")).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
    expect(getRoutePermission("/api/v1/admin/custom-field-definitions/reorder", "POST")).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
    expect(getRoutePermission("/api/v1/admin/custom-field-definitions/cfd_1", "PATCH")).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
    expect(getRoutePermission("/api/v1/admin/custom-field-definitions/cfd_1", "DELETE")).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
    const families = {
      product: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT],
      variant: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT],
      customer: [PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.CUSTOMERS_EDIT],
      order: [PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_EDIT],
      category: [PERMISSIONS.CATEGORIES_VIEW, PERMISSIONS.CATEGORIES_EDIT],
      collection: [PERMISSIONS.COLLECTIONS_VIEW, PERMISSIONS.COLLECTIONS_EDIT],
      brand: [PERMISSIONS.CATEGORIES_VIEW, PERMISSIONS.CATEGORIES_EDIT],
      page: [PERMISSIONS.PAGES_VIEW, PERMISSIONS.PAGES_EDIT],
    } as const;
    for (const ownerType of CUSTOM_FIELD_OWNER_TYPES) {
      const [view, edit] = families[ownerType];
      expect(getRoutePermission(`/api/v1/admin/custom-fields/${ownerType}/id_1`, "GET"), ownerType).toEqual({ permission: view });
      expect(getRoutePermission(`/api/v1/admin/custom-fields/${ownerType}/id_1`, "PUT"), ownerType).toEqual({ permission: edit });
      expect(classifyAdminRuntimePath(`/api/v1/admin/custom-fields/${ownerType}/id_1`)).toBe("content");
    }
    expect(getRoutePermission("/api/v1/admin/custom-fields/unknown/id_1", "GET")).toBeNull();
    expect(classifyAdminRuntimePath("/api/v1/admin/custom-field-definitions")).toBe("content");
    expect(hasPageAccess(new Set([PERMISSIONS.SETTINGS_GENERAL_VIEW]), false, "/admin/settings/custom-data")).toBe(true);
    expect(hasPageAccess(new Set([PERMISSIONS.PRODUCTS_VIEW]), false, "/admin/settings/custom-data")).toBe(false);
  });
});
