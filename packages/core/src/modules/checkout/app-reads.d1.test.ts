// Declared reads of checkout app functions on the migrated schema: keys,
// one hop, per-line records, custom fields, the shared batch and the bounds.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { objectTypeDeclarationSchema, objectTypeId, type ObjectTypeDeclaration } from "@scalius/shared/plugins/objects";
import { putObjectRecord } from "../objects";
import { appReadKey, createAppReadsCache, loadAppFunctionReads, planAppFunctionReads, type AppFunctionReadRequest } from "./app-reads";

const APP = "acme.wholesale";
const declare = (fields: unknown[]) => objectTypeDeclarationSchema.parse({ name: "Type", fields });
const OBJECTS: Record<string, ObjectTypeDeclaration> = {
  members: declare([{ key: "company_id", name: "Company", type: "object_reference", to: "acme.wholesale.companies" }]),
  companies: declare([{ key: "name", name: "Name", type: "single_line_text" }, { key: "credit", name: "Credit", type: "money" }]),
  moq: declare([{ key: "min_qty", name: "Minimum", type: "integer" }]),
};
let sqlite: DatabaseSync;
let db: Database;

beforeEach(async () => {
  ({ sqlite, db } = createSqliteD1Database());
  for (const [name, declaration] of Object.entries(OBJECTS)) {
    sqlite.prepare("INSERT INTO object_types (id,namespace,type,name,fields_json,indexes_json,unique_json) VALUES (?,?,?,?,?,?,?)")
      .run(objectTypeId(APP, name), APP, name, "Type", JSON.stringify(declaration.fields), "[]", "[]");
  }
  await putObjectRecord(db, APP, "companies", OBJECTS.companies!, "co_1", { name: "Acme Ltd", credit: { amountMinor: 150000, currency: "BDT" } });
  await putObjectRecord(db, APP, "members", OBJECTS.members!, "cust_1", { company_id: "co_1" });
  await putObjectRecord(db, APP, "moq", OBJECTS.moq!, "v_1", { min_qty: 3 });
  sqlite.exec(`
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_1', 'Tea', 'tea', 50000, 1);
    INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type) VALUES ('cfd_wholesale_min', 'product', 'acme.wholesale', 'min_qty', 'Minimum', 'integer');
    INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES ('cfd_wholesale_min', 'product', 'p_1', '6');
  `);
});
afterEach(() => sqlite.close());

const request = (reads: AppFunctionReadRequest["reads"], point: AppFunctionReadRequest["point"] = "cart.validate"): AppFunctionReadRequest => ({ pluginId: APP, point, reads, objects: OBJECTS });
const member = { as: "member", object: "members", key: "customer" } as const;
const company = { as: "company", object: "companies", key: { from: "member.company_id" } } as const;
const context = { customerId: "cust_1", variantIds: ["v_1", "v_2", "v_1"], productIds: ["p_1"], attributes: {} };

describe("declared reads", () => {
  it("resolves a customer key, one hop, per-line records and the app's custom fields; commit targets for single keys", async () => {
    const set = await loadAppFunctionReads(db, [request([member, company, { as: "moq", object: "moq", key: "line.variantId" }, { as: "fields", customFields: ["product:min_qty"] }])], context);
    expect(set.results.get(appReadKey(APP, "cart.validate"))).toEqual({
      ok: true,
      reads: {
        member: { revision: 1, data: { company_id: "co_1" } },
        // Money in the one app wire form, as ctx.objects reads it.
        company: { revision: 1, data: { name: "Acme Ltd", credit: { amountMinor: 150000, currency: "BDT" } } },
        moq: { v_1: { revision: 1, data: { min_qty: 3 } } },
        fields: { p_1: { revision: 0, data: { min_qty: 6 } } },
      },
      targets: {
        member: { object: "members", id: "cust_1", revision: 1, context: expect.any(Object) },
        company: { object: "companies", id: "co_1", revision: 1, context: expect.any(Object) },
      },
    });
  });

  it("gives a guest null single-key reads, no hop and nothing to commit", async () => {
    const set = await loadAppFunctionReads(db, [request([member, company])], { ...context, customerId: null });
    expect(set.results.get(appReadKey(APP, "cart.validate"))).toEqual({ ok: true, reads: { member: null, company: null }, targets: {} });
  });

  it("keys an attribute read by the app's own attribute value, and a missing record as a create target", async () => {
    const set = await loadAppFunctionReads(db, [request([{ as: "picked", object: "companies", key: "attribute.company" }])], {
      ...context, attributes: { "acme.wholesale.company": "co_9", "other.app.company": "co_1" },
    });
    expect(set.results.get(appReadKey(APP, "cart.validate"))).toMatchObject({ ok: true, reads: { picked: null }, targets: { picked: { id: "co_9", revision: null } } });
  });

  it("reads every app and point of a checkout in one batch, one statement per type, hop and field group", () => {
    const plan = planAppFunctionReads([
      request([member, company, { as: "moq", object: "moq", key: "line.variantId" }]),
      request([member, company], "checkout.discounts"),
      request([member, { as: "fields", customFields: ["product:min_qty"] }], "checkout.payment_methods"),
    ], context)!;
    // members, moq, the hop (shared), the field group.
    expect(plan.statements(db)).toHaveLength(4);
    expect(planAppFunctionReads([request([])], context)).toBeNull();
  });

  it("refuses a function over its bounds before reading anything for it", async () => {
    const lines = { ...context, variantIds: Array.from({ length: 30 }, (_, index) => `v_${index}`) };
    const tooMany = await loadAppFunctionReads(db, [request([{ as: "moq", object: "moq", key: "line.variantId", max: 20 }])], lines);
    expect(tooMany.results.get(appReadKey(APP, "cart.validate"))).toEqual({ ok: false, reason: "Read moq needs 30 records, more than its max of 20." });
    // A full cart fits every per-line read: four reads of 99 lines each run.
    const full = { ...context, variantIds: Array.from({ length: 99 }, (_, index) => `v_${index}`) };
    const perLine = (as: string) => ({ as, object: "moq", key: "line.variantId" as const });
    const fourReads = await loadAppFunctionReads(db, [request([perLine("a"), perLine("b"), perLine("c"), perLine("d")])], full);
    expect(fourReads.results.get(appReadKey(APP, "cart.validate"))).toMatchObject({ ok: true });
    expect(planAppFunctionReads([request([{ as: "moq", object: "moq", key: "line.variantId", max: 20 }])], lines)!.statements(db)).toHaveLength(0);
  });

  it("caches per request: a facts batch's reads answer later calls; a missing app is read once", async () => {
    const cache = createAppReadsCache(db);
    const requests = [request([member])];
    let batches = 0;
    const counting = new Proxy(db, { get: (target, property, receiver) => (property === "batch" ? (...args: unknown[]) => { batches += 1; return (target.batch as (...a: unknown[]) => unknown)(...args); } : Reflect.get(target, property, receiver)) });
    const counted = createAppReadsCache(counting as Database);
    await Promise.all([counted.get(requests, context, APP, "cart.validate"), counted.get(requests, context, APP, "cart.validate")]);
    expect(batches).toBe(1);
    cache.remember(await loadAppFunctionReads(db, requests, context));
    expect(await cache.get(requests, context, APP, "cart.validate")).toMatchObject({ ok: true, reads: { member: { data: { company_id: "co_1" } } } });
  });
});
