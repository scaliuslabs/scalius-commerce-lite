import {
    DatabaseSync,
    type SQLInputValue,
    type SQLOutputValue,
    type StatementSync,
} from "node:sqlite";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/d1";
import { expect, it } from "vitest";

import {
    resolveProductMediaProjectionRows,
    resolveSkuImageRepresentation,
    selectCheckoutProductMediaProjectionRows,
} from "./products.media";

interface SqliteD1Result {
    results: Record<string, SQLOutputValue>[];
    success: true;
    meta: Record<string, never>;
}

interface SqliteD1Statement {
    bind(...values: SQLInputValue[]): SqliteD1Statement;
    run(): Promise<SqliteD1Result>;
    all(): Promise<SqliteD1Result>;
    raw(): Promise<SQLOutputValue[][]>;
    first(column?: string): Promise<unknown>;
    execute(): SqliteD1Result;
}

function sqliteRows(
    statement: StatementSync,
    values: SQLInputValue[],
): Record<string, SQLOutputValue>[] {
    return statement.all(...values);
}

function sqliteD1Statement(
    database: DatabaseSync,
    query: string,
    values: SQLInputValue[] = [],
): SqliteD1Statement {
    const execute = (): SqliteD1Result => ({
        results: sqliteRows(database.prepare(query), values),
        success: true,
        meta: {},
    });
    return {
        bind: (...nextValues) => sqliteD1Statement(database, query, nextValues),
        run: async () => execute(),
        all: async () => execute(),
        raw: async () => {
            const statement = database.prepare(query);
            statement.setReturnArrays(true);
            return statement.all(...values) as unknown as SQLOutputValue[][];
        },
        first: async (column) => {
            const row = sqliteRows(database.prepare(query), values)[0];
            return column ? row?.[column] ?? null : row ?? null;
        },
        execute,
    };
}

function sqliteD1Database(database: DatabaseSync): Database {
    const binding = {
        prepare: (query: string) => sqliteD1Statement(database, query),
        async batch(statements: SqliteD1Statement[]) {
            database.exec("BEGIN");
            try {
                const results = statements.map((statement) => statement.execute());
                database.exec("COMMIT");
                return results;
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        },
    };
    return drizzle(binding as unknown as D1Database, { schema }) as unknown as Database;
}

it("preserves joined media fields through object-shaped D1 batch results", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
        CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE media (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            object_key TEXT NOT NULL,
            alt_text TEXT,
            caption TEXT,
            width INTEGER,
            height INTEGER,
            duration_ms INTEGER,
            poster_media_id TEXT,
            status TEXT NOT NULL
        );
        CREATE TABLE product_media (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            media_id TEXT NOT NULL,
            alt_text TEXT,
            is_primary INTEGER NOT NULL,
            sort_order INTEGER NOT NULL
        );
        CREATE TABLE product_variants (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            image_id TEXT,
            deleted_at INTEGER
        );
        INSERT INTO products VALUES ('product_1', 'Product 1');
        INSERT INTO media VALUES
            ('media_image', 'image', 'media/image.webp', 'Image alt', NULL, 800, 800, NULL, NULL, 'ready'),
            ('media_poster', 'image', 'media/poster.webp', 'Poster alt', NULL, 800, 800, NULL, NULL, 'ready'),
            ('media_video', 'video', 'media/video.mp4', 'Video alt', NULL, 1280, 720, 2000, 'media_poster', 'ready');
        INSERT INTO product_media VALUES
            ('pmed_video', 'product_1', 'media_video', 'Context video', 1, 0),
            ('pmed_image', 'product_1', 'media_image', 'Context image', 0, 1);
        INSERT INTO product_variants VALUES ('variant_1', 'product_1', 'pmed_image', NULL);
    `);
    const db = sqliteD1Database(database);

    const [rows] = await db.batch([
        selectCheckoutProductMediaProjectionRows(db, ["product_1"], ["variant_1"]),
    ]);

    expect(rows).toEqual([
        expect.objectContaining({
            id: "pmed_video",
            kind: "video",
            objectKey: "media/video.mp4",
            contextualAltText: "Context video",
            posterMediaId: "media_poster",
            posterObjectKey: "media/poster.webp",
            posterKind: "image",
            posterStatus: "ready",
        }),
        expect.objectContaining({
            id: "pmed_image",
            kind: "image",
            objectKey: "media/image.webp",
            contextualAltText: "Context image",
            posterMediaId: null,
            posterObjectKey: null,
            posterKind: null,
            posterStatus: null,
        }),
    ]);
    const projections = resolveProductMediaProjectionRows(rows);
    expect(resolveSkuImageRepresentation(projections.get("product_1") ?? [], "pmed_image"))
        .toMatchObject({
            productMediaId: "pmed_image",
            mediaId: "media_image",
            source: "exact-sku",
        });
    database.close();
});
