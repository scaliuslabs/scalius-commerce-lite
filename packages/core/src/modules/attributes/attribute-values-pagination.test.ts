import { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    addAttributeValue,
    createAttribute,
    listAttributes,
    listAttributeValues,
    renameAttributeValue,
    updateAttribute,
} from "./attributes.service";

let sqlite: DatabaseSync;
let db: Database;
let boundParameterCounts: number[];

function createDatabase(): Database {
    const proxy = drizzle(async (query, params, method) => {
        boundParameterCounts.push(params.length);
        if (params.length > 100) {
            throw new Error(`D1 bound-parameter limit exceeded: ${params.length}`);
        }

        const statement = sqlite.prepare(query);
        statement.setReturnArrays(true);
        if (method === "run") {
            statement.run(...params);
            return { rows: [] };
        }
        if (method === "get") {
            return { rows: statement.get(...params) as unknown as unknown[] };
        }
        return { rows: statement.all(...params) as unknown as unknown[][] };
    });

    return proxy as unknown as Database;
}

function createSchema(): void {
    sqlite.exec(`
        CREATE TABLE product_attributes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            filterable INTEGER NOT NULL DEFAULT 1,
            options TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER
        );
        CREATE TABLE products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            deleted_at INTEGER
        );
        CREATE TABLE product_attribute_values (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            attribute_id TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
    `);
}

function insertAttribute(id: string, options: string[], deletedAt: number | null = null): void {
    sqlite.prepare(`
        INSERT INTO product_attributes (
            id, name, slug, filterable, options, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, 1, ?, 1, 1000, ?)
    `).run(id, `Attribute ${id}`, id, JSON.stringify(options), deletedAt);
}

function insertValue(
    attributeId: string,
    productIndex: number,
    value: string,
    createdAt: number,
): void {
    const productId = `product_${attributeId}_${productIndex}`;
    sqlite.prepare(
        "INSERT INTO products (id, name, deleted_at) VALUES (?, ?, NULL)",
    ).run(productId, `Product ${productIndex}`);
    sqlite.prepare(`
        INSERT INTO product_attribute_values (
            id, product_id, attribute_id, value, created_at
        ) VALUES (?, ?, ?, ?, ?)
    `).run(`value_${attributeId}_${productIndex}`, productId, attributeId, value, createdAt);
}

describe("attribute value pagination", () => {
    beforeEach(() => {
        sqlite = new DatabaseSync(":memory:");
        boundParameterCounts = [];
        createSchema();
        db = createDatabase();
    });

    afterEach(() => {
        sqlite.close();
    });

    it("reconciles used presets globally and returns non-page-local totals", async () => {
        insertAttribute("color", [
            "Preset Used",
            "Preset A",
            "Preset B",
            " preset a ",
        ]);

        for (let index = 1; index <= 45; index += 1) {
            insertValue(
                "color",
                index,
                index === 5 ? " preset USED " : `Value ${index.toString().padStart(2, "0")}`,
                index,
            );
        }
        for (let index = 46; index <= 55; index += 1) {
            insertValue("color", index, "Common", index);
        }

        const lastPage = await listAttributeValues(db, "color", {
            page: 3,
            limit: 20,
            sort: "asc",
        });

        expect(lastPage).toMatchObject({
            page: 3,
            limit: 20,
            totalValues: 48,
            totalProducts: 55,
            totalPages: 3,
        });
        expect(lastPage.values).toHaveLength(8);
        expect(lastPage.values.filter((value) => value.value === "Preset Used")).toHaveLength(0);
        expect(lastPage.values.slice(-2).map((value) => value.value)).toEqual([
            "Preset A",
            "Preset B",
        ]);
        expect(lastPage.values.find((value) => value.value === "Common")?.sampleProducts)
            .toHaveLength(5);

        const searchResult = await listAttributeValues(db, "color", {
            search: "preset",
            page: 1,
            limit: 20,
            sort: "asc",
        });

        expect(searchResult).toMatchObject({
            totalValues: 3,
            totalProducts: 1,
            totalPages: 1,
        });
        expect(searchResult.values.map((value) => value.value)).toEqual([
            " preset USED ",
            "Preset A",
            "Preset B",
        ]);
        expect(searchResult.values[0]?.isPreset).toBe(true);

    });

    it("deduplicates large preset sets without crossing D1's parameter limit", async () => {
        const presets = Array.from({ length: 205 }, (_, index) => `Preset ${index}`);
        insertAttribute("material", [...presets, " preset 0 ", "PRESET 204"]);
        for (let index = 0; index < 100; index += 1) {
            insertValue("material", index, `Preset ${index}`, index + 1);
        }

        await listAttributeValues(db, "material", {
            page: 1,
            limit: 100,
            sort: "asc",
        });

        const result = await listAttributeValues(db, "material", {
            page: 3,
            limit: 100,
        });

        expect(result).toMatchObject({
            page: 3,
            limit: 100,
            totalValues: 205,
            totalProducts: 100,
            totalPages: 3,
        });
        expect(result.values).toHaveLength(5);
        expect(new Set(result.values.map((value) => value.value)).size).toBe(5);
        expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(100);
    });

    it("rejects normalized preset duplicates and rename-to-existing preset collisions", async () => {
        insertAttribute("swatch", ["Red", " Blue ", "blue"]);

        await expect(addAttributeValue(db, "swatch", " red ")).rejects.toThrow(
            'Value "red" already exists for this attribute',
        );
        await expect(
            renameAttributeValue(db, "swatch", "Blue", " RED "),
        ).rejects.toThrow('Value "RED" already exists for this attribute');

        const result = await listAttributeValues(db, "swatch");
        expect(result.values.map((value) => value.value)).toEqual(["Red", "Blue"]);
        expect(result.totalValues).toBe(2);
    });

    it("rejects normalized definition conflicts and edits to trashed definitions", async () => {
        insertAttribute("material", []);
        insertAttribute("trashed", [], 123);

        await expect(createAttribute(db, {
            name: "  ATTRIBUTE MATERIAL ",
            slug: "different-slug",
            filterable: true,
        })).rejects.toThrow("already exists");
        await expect(updateAttribute(db, "material", {
            slug: " TRASHED ".trim().toLowerCase(),
        })).rejects.toThrow("already exists");
        await expect(updateAttribute(db, "trashed", { name: "Updated" }))
            .rejects.toThrow("Attribute not found");
        await expect(addAttributeValue(db, "trashed", "New"))
            .rejects.toThrow("Attribute not found");
    });

    it("blocks renaming a value onto an existing assigned value", async () => {
        insertAttribute("finish", []);
        insertValue("finish", 1, "Matte", 1);
        insertValue("finish", 2, " Glossy ", 2);

        await expect(renameAttributeValue(db, "finish", "Matte", "glossy"))
            .rejects.toThrow('Value "glossy" already exists for this attribute');
    });

    it("resolves assigned definitions by one bounded ID set", async () => {
        insertAttribute("material", []);
        insertAttribute("brand", []);
        insertAttribute("hidden", [], 123);

        const result = await listAttributes(db, {
            ids: ["brand", "missing", "material", "brand"],
            page: 1,
            limit: 90,
        });

        expect(result.attributes.map((attribute) => attribute.id)).toEqual(["brand", "material"]);
        expect(result.pagination).toMatchObject({ total: 2, page: 1, limit: 90 });
        await expect(listAttributes(db, {
            ids: Array.from({ length: 91 }, (_, index) => `attr_${index}`),
        })).rejects.toThrow("Select at most 90 attributes");
        expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(100);
    });
});
