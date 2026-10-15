import type { DatabaseSync } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import { MERCHANT_CUSTOM_FIELD_WRITER, type CustomFieldWriter } from "@scalius/shared/custom-fields";
import { afterEach, describe, expect, it } from "vitest";

import { AppError, NotFoundError, ValidationError } from "@scalius/core/errors";
import {
    CustomFieldNamespaceError,
    CustomFieldRevisionConflictError,
    createCustomFieldDefinition,
    deleteCustomFieldDefinition,
    listCustomFieldDefinitions,
    readCustomFieldValues,
    readCustomFieldValuesForOwners,
    reorderCustomFieldDefinitions,
    setCustomFieldValues,
    updateCustomFieldDefinition,
} from "./custom-fields.service";
import { createCustomFieldDefinitionSchema } from "./custom-fields.validation";
import { presentStorefrontCustomFields, selectStorefrontCustomFieldRows } from "./custom-fields.storefront";
import { deps, withDependencyScope } from "../../cache-deps";
import { withPublicMediaUrl } from "../../integrations/storage";
import { rebuildCatalogProjections } from "../products";

const merchant = { writer: MERCHANT_CUSTOM_FIELD_WRITER };
const plugin = (pluginId: string): { writer: CustomFieldWriter } => ({ writer: { kind: "plugin", pluginId } });

let sqlite: DatabaseSync | null = null;
afterEach(() => {
    sqlite?.close();
    sqlite = null;
});

function database(onQuery?: () => void): Database {
    const harness = createSqliteD1Database({ onQuery });
    sqlite = harness.sqlite;
    sqlite.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'A', 'a', 'published');
        INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES
            ('prod_a', 'Panjabi', 100000, 'panjabi', 'cat_a', 1),
            ('prod_b', 'Saree', 200000, 'saree', 'cat_a', 1),
            ('prod_trashed', 'Old', 100, 'old', 'cat_a', 0);
        UPDATE products SET deleted_at = unixepoch() WHERE id = 'prod_trashed';
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default) VALUES ('var_a', 'prod_a', 'PJ-1', 100000, 3, 1);
        INSERT INTO collections (id, name, presentation, config) VALUES ('col_a', 'Eid', 'grid', '{}');
        INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES ('med_a', 'a.png', 'image', 'media/a.png', 1, 'image/png', 'ready');
        INSERT INTO customers (id, name, phone) VALUES ('cus_a', 'Buyer', '01711000000');
    `);
    return harness.db;
}

function define(db: Database, input: Record<string, unknown>, options = merchant) {
    return createCustomFieldDefinition(db, createCustomFieldDefinitionSchema.parse({ ownerType: "product", ...input }), options);
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
}

function cacheSeq(dep: string): number {
    const row = sqlite!.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(dep) as { seq: number } | undefined;
    return Number(row?.seq ?? 0);
}

describe("custom field definitions", () => {
    it("derives the key, appends in order and keeps (owner, namespace, key) unique", async () => {
        const db = database();
        const care = await define(db, { name: "Care guide", type: "multi_line_text" });
        const fabric = await define(db, { name: "Fabric", type: "single_line_text", validations: { choices: ["Cotton", "Silk"] } });
        expect(care).toMatchObject({ namespace: "custom", key: "care_guide", position: 0, revision: 1, storefrontVisible: false });
        expect(fabric).toMatchObject({ key: "fabric", position: 1, validations: { choices: ["Cotton", "Silk"], min: null } });
        const taken = await rejection(define(db, { name: "Care", key: "care_guide", type: "url" }));
        expect(taken).toMatchObject({ status: 409, code: "CUSTOM_FIELD_KEY_TAKEN" });
        // The same key is free for another owner type.
        await expect(define(db, { ownerType: "variant", name: "Care guide", type: "multi_line_text" })).resolves.toMatchObject({ position: 0 });
        const { definitions } = await listCustomFieldDefinitions(db, { ownerType: "product" });
        expect(definitions.map((definition) => definition.key)).toEqual(["care_guide", "fabric"]);
    });

    it("refuses bad validations, storefront customer fields and foreign namespaces", async () => {
        const db = database();
        expect((await rejection(define(db, { name: "Size", type: "integer", validations: { min: 5, max: 1 } }))).status).toBe(400);
        const hidden = await rejection(define(db, { ownerType: "customer", name: "VIP", type: "boolean", storefrontVisible: true }));
        expect(hidden).toBeInstanceOf(ValidationError);
        const foreign = await rejection(define(db, { name: "Points", namespace: "acme.loyalty", type: "integer" }));
        expect(foreign).toBeInstanceOf(CustomFieldNamespaceError);
        expect(foreign).toMatchObject({ status: 403, code: "CUSTOM_FIELD_NAMESPACE_FORBIDDEN" });
        // A plugin writes its own namespace (its default) and never `custom`.
        await expect(define(db, { name: "Points", type: "integer" }, plugin("acme.loyalty"))).resolves.toMatchObject({ namespace: "acme.loyalty", key: "points" });
        expect(await rejection(define(db, { name: "Points", namespace: "custom", type: "integer" }, plugin("acme.loyalty")))).toBeInstanceOf(CustomFieldNamespaceError);
    });

    it("edits and deletes under the revision, and only in the writer's namespace", async () => {
        const db = database();
        const field = await define(db, { name: "Care", type: "single_line_text" });
        const edited = await updateCustomFieldDefinition(db, field.id, { expectedRevision: 1, name: "Care guide", storefrontVisible: true, validations: { max: 40 } }, merchant);
        expect(edited).toMatchObject({ name: "Care guide", storefrontVisible: true, revision: 2, key: "care", validations: { max: 40 } });
        const stale = await rejection(updateCustomFieldDefinition(db, field.id, { expectedRevision: 1, name: "Late" }, merchant));
        expect(stale).toBeInstanceOf(CustomFieldRevisionConflictError);
        expect(stale.details).toMatchObject({ expectedRevision: 1, currentRevision: 2 });

        const points = await define(db, { name: "Points", type: "integer" }, plugin("acme.loyalty"));
        expect(await rejection(updateCustomFieldDefinition(db, points.id, { expectedRevision: 1, name: "Mine" }, merchant))).toBeInstanceOf(CustomFieldNamespaceError);
        expect(await rejection(deleteCustomFieldDefinition(db, points.id, { expectedRevision: 1 }, merchant))).toBeInstanceOf(CustomFieldNamespaceError);

        await setCustomFieldValues(db, "product", "prod_a", { values: [{ definitionId: field.id, value: "Hand wash" }] }, merchant);
        await setCustomFieldValues(db, "product", "prod_b", { values: [{ definitionId: field.id, value: "Dry clean" }] }, merchant);
        expect((await listCustomFieldDefinitions(db, { ownerType: "product" })).definitions.find((item) => item.id === field.id)?.valueCount).toBe(2);
        expect(await rejection(deleteCustomFieldDefinition(db, field.id, { expectedRevision: 1 }, merchant))).toBeInstanceOf(CustomFieldRevisionConflictError);
        await expect(deleteCustomFieldDefinition(db, field.id, { expectedRevision: 2 }, merchant)).resolves.toEqual({ id: field.id, deletedValueCount: 2 });
        expect(sqlite!.prepare("SELECT count(*) AS n FROM custom_field_values").get()).toEqual({ n: 0 });
        expect(await rejection(deleteCustomFieldDefinition(db, field.id, { expectedRevision: 2 }, merchant))).toBeInstanceOf(NotFoundError);
    });

    it("reorders the whole set of an owner type, all or none", async () => {
        const db = database();
        const [a, b, c] = [
            await define(db, { name: "Alpha", type: "integer" }),
            await define(db, { name: "Beta", type: "integer" }),
            await define(db, { name: "Gamma", type: "integer" }),
        ];
        const claims = [c!, a!, b!].map((definition) => ({ id: definition.id, expectedRevision: definition.revision }));
        const { definitions } = await reorderCustomFieldDefinitions(db, { ownerType: "product", definitions: claims });
        expect(definitions.map((definition) => [definition.key, definition.position, definition.revision])).toEqual([["gamma", 0, 2], ["alpha", 1, 2], ["beta", 2, 2]]);
        // Stale revisions and partial sets change nothing.
        expect(await rejection(reorderCustomFieldDefinitions(db, { ownerType: "product", definitions: claims }))).toBeInstanceOf(CustomFieldRevisionConflictError);
        const partial = definitions.slice(0, 2).map((definition) => ({ id: definition.id, expectedRevision: definition.revision }));
        expect((await rejection(reorderCustomFieldDefinitions(db, { ownerType: "product", definitions: partial }))).status).toBe(409);
        expect((await listCustomFieldDefinitions(db, { ownerType: "product" })).definitions.map((definition) => definition.key)).toEqual(["gamma", "alpha", "beta"]);
    });
});

describe("custom field values", () => {
    async function fields(db: Database) {
        return {
            care: await define(db, { name: "Care", type: "single_line_text", storefrontVisible: true, validations: { max: 20 } }),
            weight: await define(db, { name: "Weight", type: "decimal" }),
            msrp: await define(db, { name: "MSRP", type: "money", storefrontVisible: true }),
            related: await define(db, { name: "Related", type: "list.product_reference" }),
            swatch: await define(db, { name: "Swatch", type: "media_reference" }),
        };
    }

    it("sets, reads and clears an owner's values with money in major units", async () => {
        const db = database();
        const { care, weight, msrp, related, swatch } = await fields(db);
        const saved = await setCustomFieldValues(db, "product", "prod_a", {
            values: [
                { definitionId: care.id, value: " Hand wash " },
                { definitionId: weight.id, value: "1.250" },
                { definitionId: msrp.id, value: 1500 },
                { definitionId: related.id, value: ["prod_b"] },
                { definitionId: swatch.id, value: "med_a" },
            ],
        }, merchant);
        const read = await readCustomFieldValues(db, "product", "prod_a");
        expect(read.fields.map((field) => [field.definition.key, field.value])).toEqual([
            ["care", "Hand wash"], ["weight", "1.25"], ["msrp", 1500], ["related", ["prod_b"]], ["swatch", "med_a"],
        ]);
        expect(saved.fields.map((field) => field.value)).toEqual(read.fields.map((field) => field.value));
        expect(sqlite!.prepare("SELECT value FROM custom_field_values WHERE definition_id = ?").get(msrp.id)).toEqual({ value: "150000" });

        await setCustomFieldValues(db, "product", "prod_a", { values: [{ definitionId: care.id, value: null }, { definitionId: related.id, value: [] }] }, merchant);
        const cleared = await readCustomFieldValues(db, "product", "prod_a");
        expect(cleared.fields.filter((field) => field.value !== null).map((field) => field.definition.key)).toEqual(["weight", "msrp", "swatch"]);
        expect(cleared.fields[0]).toMatchObject({ value: null, updatedAt: null });
    });

    it("writes all or nothing: one invalid value or missing reference refuses the batch", async () => {
        const db = database();
        const { care, weight, related, msrp } = await fields(db);
        const invalid = await rejection(setCustomFieldValues(db, "product", "prod_a", {
            values: [{ definitionId: weight.id, value: "2" }, { definitionId: care.id, value: "x".repeat(21) }, { definitionId: msrp.id, value: 12.5 }],
        }, merchant));
        expect(invalid).toBeInstanceOf(ValidationError);
        expect((invalid.details as { issues: unknown[] }).issues).toEqual([
            expect.objectContaining({ path: ["values", 1, "value"], code: "too_long", limit: 20 }),
            expect.objectContaining({ path: ["values", 2, "value"], code: "whole_amount" }),
        ]);
        const missing = await rejection(setCustomFieldValues(db, "product", "prod_a", {
            values: [{ definitionId: weight.id, value: "2" }, { definitionId: related.id, value: ["prod_b", "prod_trashed", "prod_nope"] }],
        }, merchant));
        expect((missing.details as { issues: Array<{ path: unknown[]; code: string }> }).issues).toEqual([
            expect.objectContaining({ path: ["values", 1, "value"], code: "missing_reference" }),
            expect.objectContaining({ path: ["values", 1, "value"], code: "missing_reference" }),
        ]);
        expect(sqlite!.prepare("SELECT count(*) AS n FROM custom_field_values").get()).toEqual({ n: 0 });
        // Another owner type's field, a duplicate, a trashed or unknown owner.
        const variantField = await define(db, { ownerType: "variant", name: "Fit", type: "single_line_text" });
        expect((await rejection(setCustomFieldValues(db, "product", "prod_a", { values: [{ definitionId: variantField.id, value: "Slim" }] }, merchant))).status).toBe(400);
        expect((await rejection(setCustomFieldValues(db, "product", "prod_a", { values: [{ definitionId: care.id, value: "a" }, { definitionId: care.id, value: "b" }] }, merchant))).status).toBe(400);
        expect(await rejection(setCustomFieldValues(db, "product", "prod_trashed", { values: [{ definitionId: care.id, value: "a" }] }, merchant))).toBeInstanceOf(NotFoundError);
        // A product in trash keeps (and shows) its values, but takes no writes.
        await expect(readCustomFieldValues(db, "product", "prod_trashed")).resolves.toMatchObject({ ownerId: "prod_trashed" });
        expect(await rejection(readCustomFieldValues(db, "customer", "cus_nope"))).toBeInstanceOf(NotFoundError);
    });

    it("lets a plugin write only its own namespace; the merchant reads every namespace", async () => {
        const db = database();
        const points = await define(db, { ownerType: "customer", name: "Points", type: "integer" }, plugin("acme.loyalty"));
        const note = await define(db, { ownerType: "customer", name: "Note", type: "multi_line_text" });
        expect(await rejection(setCustomFieldValues(db, "customer", "cus_a", { values: [{ definitionId: points.id, value: 10 }] }, merchant)))
            .toBeInstanceOf(CustomFieldNamespaceError);
        expect(await rejection(setCustomFieldValues(db, "customer", "cus_a", { values: [{ definitionId: note.id, value: "x" }] }, plugin("acme.loyalty"))))
            .toBeInstanceOf(CustomFieldNamespaceError);
        await setCustomFieldValues(db, "customer", "cus_a", { values: [{ definitionId: points.id, value: 10 }] }, plugin("acme.loyalty"));
        await setCustomFieldValues(db, "customer", "cus_a", { values: [{ definitionId: note.id, value: "Prefers COD" }] }, merchant);
        const read = await readCustomFieldValues(db, "customer", "cus_a");
        expect(read.fields.map((field) => [field.definition.namespace, field.value])).toEqual([["acme.loyalty", 10], ["custom", "Prefers COD"]]);
    });

    it("reads many owners in 90-id statements of one round trip", async () => {
        const db = database();
        const field = await define(db, { name: "Code", type: "single_line_text" });
        const ids = Array.from({ length: 200 }, (_, index) => `prod_bulk_${index}`);
        for (const id of ids) {
            sqlite!.prepare("INSERT INTO products (id, name, price_minor, slug) VALUES (?, 'Bulk', 100, ?)").run(id, id.replaceAll("_", "-"));
            sqlite!.prepare("INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES (?, 'product', ?, ?)").run(field.id, id, id);
        }
        const values = await readCustomFieldValuesForOwners(db, "product", [...ids, "prod_a"]);
        expect(values.size).toBe(200);
        expect(values.get("prod_bulk_150")).toEqual([expect.objectContaining({ key: "code", value: "prod_bulk_150" })]);
        expect((await readCustomFieldValuesForOwners(db, "product", ids, { storefrontOnly: true })).size).toBe(0);
    });

    it("advances the product's cache key only for storefront-visible values that changed", async () => {
        const db = database();
        const { care, weight } = await fields(db);
        const before = cacheSeq("p:prod_a");
        await setCustomFieldValues(db, "product", "prod_a", { values: [{ definitionId: care.id, value: "Hand wash" }] }, merchant);
        const afterVisible = cacheSeq("p:prod_a");
        expect(afterVisible).toBeGreaterThan(before);
        // An equal value writes nothing; a hidden field never reaches buyers.
        await setCustomFieldValues(db, "product", "prod_a", { values: [{ definitionId: care.id, value: "Hand wash " }, { definitionId: weight.id, value: 3 }] }, merchant);
        expect(cacheSeq("p:prod_a")).toBe(afterVisible);
        // Hiding the definition advances its owner type's key, which buyer reads declare.
        const beforeHide = cacheSeq("cf:product");
        await updateCustomFieldDefinition(db, care.id, { expectedRevision: care.revision, storefrontVisible: false }, merchant);
        expect(cacheSeq("cf:product")).toBeGreaterThan(beforeHide);
    });

    it("presents storefront-visible values in definition order for buyer reads", async () => {
        const db = database();
        const { care, weight, msrp } = await fields(db);
        await setCustomFieldValues(db, "product", "prod_a", {
            values: [{ definitionId: care.id, value: "Hand wash" }, { definitionId: weight.id, value: 2 }, { definitionId: msrp.id, value: 1200 }],
        }, merchant);
        const rows = await selectStorefrontCustomFieldRows(db, "product", "prod_a").all();
        expect(presentStorefrontCustomFields(rows)).toEqual([
            { namespace: "custom", key: "care", name: "Care", type: "single_line_text", value: "Hand wash" },
            { namespace: "custom", key: "msrp", name: "MSRP", type: "money", value: 1200 },
        ]);
    });

    it("resolves public scalar references in one statement and tracks hidden targets precisely", async () => {
        let statements = 0;
        const db = database(() => { statements++; });
        const product = await define(db, { name: "Related product", type: "product_reference", storefrontVisible: true });
        const collection = await define(db, { name: "Collection", type: "collection_reference", storefrontVisible: true });
        const photo = await define(db, { name: "Photo", type: "media_reference", storefrontVisible: true });
        await setCustomFieldValues(db, "product", "prod_a", { values: [
            { definitionId: product.id, value: "prod_a" },
            { definitionId: collection.id, value: "col_a" },
            { definitionId: photo.id, value: "med_a" },
        ] }, merchant);
        sqlite!.exec(`
            UPDATE products SET canonical_path = '/products/linen-panjabi' WHERE id = 'prod_a';
            UPDATE collections SET canonical_path = '/collections/col_featured' WHERE id = 'col_a';
            UPDATE media SET alt_text = 'Linen weave', width = 800, height = 600, variant_width = 640 WHERE id = 'med_a';
        `);
        await rebuildCatalogProjections(db);
        const read = () => withPublicMediaUrl("https://cdn.example.com", () => withDependencyScope(async () => {
            deps.product("prod_a");
            return presentStorefrontCustomFields(await selectStorefrontCustomFieldRows(db, "product", "prod_a").all());
        }, { strict: true }));
        statements = 0;
        const visible = await read();
        expect(statements).toBe(1);
        expect(visible.value.map(({ value, reference }) => ({ value, reference }))).toEqual([
            { value: "prod_a", reference: { id: "prod_a", url: "/products/linen-panjabi" } },
            { value: "col_a", reference: { id: "col_a", url: "/collections/col_featured" } },
            { value: "med_a", reference: { id: "med_a", url: "https://cdn.example.com/media/a.png/640.webp", alt: "Linen weave", width: 800, height: 600 } },
        ]);
        expect(visible.dependencies.keys).toEqual(expect.arrayContaining(["p:prod_a", "col:col_a", "m:med_a"]));
        expect(visible.dependencies.coarseTables).toEqual([]);
        sqlite!.exec(`
            UPDATE product_channel_publications SET unpublished_at = unixepoch() WHERE product_id = 'prod_a' AND channel_id = 'sc_online_store';
            UPDATE collections SET is_active = 0 WHERE id = 'col_a';
            UPDATE media SET status = 'trashed', trashed_at = unixepoch() WHERE id = 'med_a';
        `);
        const hidden = await read();
        expect(hidden.value.map(({ reference }) => reference)).toEqual([undefined, undefined, undefined]);
        expect(hidden.dependencies.keys).toEqual(visible.dependencies.keys);
    });

    it("keeps empty and ordinary-field reads precisely cacheable and refuses media without a public origin", async () => {
        const db = database();
        const read = () => withDependencyScope(async () => {
            deps.product("prod_a");
            return presentStorefrontCustomFields(await selectStorefrontCustomFieldRows(db, "product", "prod_a").all());
        }, { strict: true });
        expect((await read()).value).toEqual([]);
        const photo = await define(db, { name: "Photo", type: "media_reference", storefrontVisible: true });
        const care = await define(db, { name: "Care", type: "single_line_text", storefrontVisible: true });
        await setCustomFieldValues(db, "product", "prod_a", { values: [
            { definitionId: photo.id, value: "med_a" }, { definitionId: care.id, value: "Hand wash" },
        ] }, merchant);
        const result = await read();
        expect(result.value.map(({ reference }) => reference)).toEqual([undefined, undefined]);
        expect(result.dependencies.coarseTables).toEqual([]);
    });

    it("pins object references to their accessible type and nulls weak public references", async () => {
        const db = database();
        sqlite!.exec(`
            INSERT INTO object_types (id, namespace, type, name, fields_json, admin, storefront) VALUES
                ('oty_custom.charts', 'custom', 'charts', 'Charts', '[{"key":"chest","name":"Chest (cm)","type":"integer"},{"key":"buyer","name":"Buyer","type":"customer_reference"}]', 'edit', 1),
                ('oty_custom.private', 'custom', 'private', 'Private', '[]', 'none', 0);
            INSERT INTO object_records (type_id, id, data_json, status, pub) VALUES
                ('oty_custom.charts', 'chart_a', '{"chest":96,"buyer":"cus_a","undeclared":"never-public"}', 'published', 1),
                ('oty_custom.charts', 'chart_b', '{}', 'published', 1),
                ('oty_custom.charts', 'chart_draft', '{}', 'draft', 0);
        `);
        await expect(define(db, { name: "Private", type: "object_reference", validations: { to: "custom.private" } })).rejects.toBeInstanceOf(ValidationError);
        const chart = await define(db, { name: "Chart", type: "object_reference", validations: { to: "custom.charts" }, storefrontVisible: true });
        const charts = await define(db, { name: "Charts", type: "list.object_reference", validations: { to: "custom.charts" }, storefrontVisible: true });
        await expect(setCustomFieldValues(db, "product", "prod_a", { values: [{ definitionId: chart.id, value: "chart_draft" }] }, merchant)).rejects.toBeInstanceOf(ValidationError);
        const saved = await setCustomFieldValues(db, "product", "prod_a", { values: [
            { definitionId: chart.id, value: "chart_a" }, { definitionId: charts.id, value: ["chart_a", "chart_b"] },
        ] }, merchant);
        expect(saved.fields.map((entry) => entry.value)).toEqual(["chart_a", ["chart_a", "chart_b"]]);
        const read = () => withDependencyScope(async () => {
            deps.product("prod_a");
            return presentStorefrontCustomFields(await selectStorefrontCustomFieldRows(db, "product", "prod_a").all());
        }, { strict: true });
        expect((await read()).dependencies.keys).toContain("obj:oty_custom.charts");
        expect((await read()).value[0]?.object).toEqual({ handle: null, fields: [{ key: "chest", name: "Chest (cm)", type: "integer", value: 96 }] });
        sqlite!.exec(`DELETE FROM object_records WHERE type_id = 'oty_custom.charts' AND id = 'chart_a';
            UPDATE object_records SET pub = 0, status = 'draft' WHERE type_id = 'oty_custom.charts' AND id = 'chart_b';`);
        expect((await read()).value.map(({ to, value }) => ({ to, value }))).toEqual([
            { to: "custom.charts", value: null }, { to: "custom.charts", value: [null, null] },
        ]);
        expect((await readCustomFieldValues(db, "product", "prod_a")).fields.map((entry) => entry.value)).toEqual([null, [null, "chart_b"]]);
        await setCustomFieldValues(db, "product", "prod_a", { values: [{ definitionId: chart.id, value: null }] }, merchant);
    });

    it("lets an app reference only its own object namespace and keeps a populated target fixed", async () => {
        const db = database();
        sqlite!.exec(`
            INSERT INTO object_types (id, namespace, type, name, fields_json, admin) VALUES
                ('oty_acme.fit.charts', 'acme.fit', 'charts', 'Charts', '[]', 'none'),
                ('oty_custom.charts', 'custom', 'charts', 'Charts', '[]', 'edit'),
                ('oty_custom.other', 'custom', 'other', 'Other', '[]', 'edit');
            INSERT INTO object_records (type_id, id, data_json) VALUES ('oty_custom.charts', 'chart_a', '{}');
        `);
        await expect(define(db, { name: "Own", type: "object_reference", validations: { to: "acme.fit.charts" } }, plugin("acme.fit"))).resolves.toMatchObject({ validations: { to: "acme.fit.charts" } });
        await expect(define(db, { name: "Foreign", type: "object_reference", validations: { to: "acme.fit.charts" } }, plugin("other.fit"))).rejects.toBeInstanceOf(ValidationError);
        const field = await define(db, { name: "Chart", type: "object_reference", validations: { to: "custom.charts" } });
        await setCustomFieldValues(db, "product", "prod_a", { values: [{ definitionId: field.id, value: "chart_a" }] }, merchant);
        await expect(updateCustomFieldDefinition(db, field.id, { expectedRevision: field.revision, validations: { to: "custom.other" } }, merchant)).rejects.toBeInstanceOf(ValidationError);
    });
});
