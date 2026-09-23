import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { ConflictError } from "@scalius/core/errors";
import { bulkDeleteAttributes, bulkRestoreAttributes, listAttributes } from "./attributes.service";

function setup(race?: (sqlite: DatabaseSync) => void) {
    let pending = race;
    let maxBindings = 0;
    const harness = createSqliteD1Database({
        onQuery: (_query, values) => { maxBindings = Math.max(maxBindings, values.length); },
        beforeBatch(sqlite) {
            const apply = pending;
            pending = undefined;
            apply?.(sqlite);
        },
    });
    harness.sqlite.exec(`
        INSERT INTO products (id, name, price_minor, slug) VALUES ('prod_1', 'Example', 1000, 'example');
        INSERT INTO product_attributes (id, name, slug, deleted_at) VALUES
            ('attr_1', 'Color', 'color', NULL),
            ('attr_2', 'Size', 'size', 1700000000);
    `);
    const deletedAt = (id: string) =>
        (harness.sqlite.prepare("SELECT deleted_at FROM product_attributes WHERE id = ?").get(id) as
            { deleted_at: number | null } | undefined)?.deleted_at;
    return { ...harness, deletedAt, maxBindings: () => maxBindings };
}

const assign = (sqlite: DatabaseSync, attributeId: string) =>
    sqlite.prepare("INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES (?, 'prod_1', ?, 'Red')")
        .run(`pav_${attributeId}`, attributeId);

describe("attribute delete and restore integrity", () => {
    it("blocks trash and permanent delete while product values still use the attribute", async () => {
        const { sqlite, db, deletedAt } = setup();
        assign(sqlite, "attr_1");
        assign(sqlite, "attr_2");

        await expect(bulkDeleteAttributes(db, ["attr_1"], false)).rejects.toBeInstanceOf(ConflictError);
        await expect(bulkDeleteAttributes(db, ["attr_2"], true)).rejects.toBeInstanceOf(ConflictError);
        expect(deletedAt("attr_1")).toBeNull();
        expect(deletedAt("attr_2")).toBe(1700000000);
    });

    it("requires trash before permanent deletion and then deletes", async () => {
        const { db, deletedAt } = setup();

        await expect(bulkDeleteAttributes(db, ["attr_1"], true)).rejects.toThrow("Move attributes to trash");
        expect(deletedAt("attr_1")).toBeNull();

        await bulkDeleteAttributes(db, ["attr_1"], false);
        await bulkDeleteAttributes(db, ["attr_1", "attr_2"], true);
        expect(deletedAt("attr_1")).toBeUndefined();
        expect(deletedAt("attr_2")).toBeUndefined();
    });

    it("fails closed when an assignment appears after the preflight read", async () => {
        const { db, deletedAt } = setup((sqlite) => assign(sqlite, "attr_1"));

        await expect(bulkDeleteAttributes(db, ["attr_1"], false)).rejects.toBeInstanceOf(ConflictError);
        expect(deletedAt("attr_1")).toBeNull();
    });

    it("refuses to restore over an active attribute with the same normalized name", async () => {
        const { sqlite, db, deletedAt } = setup();
        sqlite.exec("UPDATE product_attributes SET name = ' size ', slug = 'size-2' WHERE id = 'attr_1'");

        await expect(bulkRestoreAttributes(db, ["attr_2"])).rejects.toBeInstanceOf(ConflictError);
        expect(deletedAt("attr_2")).not.toBeNull();
    });

    it("fails closed when a conflicting attribute becomes active after the preflight read", async () => {
        const { db, deletedAt } = setup((sqlite) => {
            sqlite.exec("INSERT INTO product_attributes (id, name, slug) VALUES ('attr_3', 'SIZE', 'size-3')");
        });

        await expect(bulkRestoreAttributes(db, ["attr_2"])).rejects.toBeInstanceOf(ConflictError);
        expect(deletedAt("attr_2")).not.toBeNull();
    });

    it("enriches a large admin page without exceeding D1's bound-parameter limit", async () => {
        const { sqlite, db, maxBindings } = setup();
        const insert = sqlite.prepare("INSERT INTO product_attributes (id, name, slug) VALUES (?, ?, ?)");
        for (let index = 0; index < 150; index += 1) insert.run(`bulk_${index}`, `Bulk ${index}`, `bulk-${index}`);
        assign(sqlite, "bulk_7");

        const { attributes } = await listAttributes(db, { limit: 500 });
        expect(attributes).toHaveLength(151);
        expect(attributes.find((attribute) => attribute.id === "bulk_7")?.valueCount).toBe(1);
        expect(maxBindings()).toBeLessThanOrEqual(100);
    });
});
