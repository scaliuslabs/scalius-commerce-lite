import type { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listMediaFiles } from "./media.service";

describe("media cursor pagination", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());

        const insert = sqlite.prepare(`
            INSERT INTO media (
                id, filename, kind, object_key, size, mime_type, alt_text,
                caption, width, height, duration_ms, poster_media_id, folder_id,
                status, version, created_at, updated_at, trashed_at, deleted_at
            ) VALUES (?, ?, 'image', ?, ?, 'image/webp', NULL, NULL, 800, 800,
                NULL, NULL, NULL, 'ready', 1, ?, ?, NULL, NULL)
        `);
        const rows: Array<[string, number]> = [
            ["media_a1", 1_000],
            ["media_a2", 1_000],
            ["media_b1", 1_001],
            ["media_b2", 1_001],
            ["media_b3", 1_001],
            ["media_c1", 1_002],
            ["media_d1", 1_003],
        ];
        rows.forEach(([id, createdAt], index) => {
            insert.run(id, `${id}.webp`, `media/${id}.webp`, index + 1, createdAt, createdAt);
        });
    });

    afterEach(() => sqlite.close());

    async function readAll(sortOrder: "asc" | "desc") {
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await listMediaFiles(db, {
                cursor,
                limit: 2,
                sortBy: "createdAt",
                sortOrder,
                view: "ready",
            });
            ids.push(...page.files.map((file) => file.id));
            cursor = page.pagination.nextCursor ?? undefined;
        } while (cursor);
        return ids;
    }

    it("encodes timestamp cursor values through the D1 column mapper without gaps or duplicates", async () => {
        await expect(readAll("asc")).resolves.toEqual([
            "media_a1",
            "media_a2",
            "media_b1",
            "media_b2",
            "media_b3",
            "media_c1",
            "media_d1",
        ]);
        await expect(readAll("desc")).resolves.toEqual([
            "media_d1",
            "media_c1",
            "media_b3",
            "media_b2",
            "media_b1",
            "media_a2",
            "media_a1",
        ]);
    });
});
