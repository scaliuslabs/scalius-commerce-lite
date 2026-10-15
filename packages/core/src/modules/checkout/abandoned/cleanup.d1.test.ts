import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { cleanupStaleAbandonedCheckouts } from "./cleanup";

describe("abandoned checkout maintenance markers", () => {
    let store: ReturnType<typeof createSqliteD1Database>;
    const now = 1_800_000_000;

    beforeEach(() => {
        store = createSqliteD1Database();
    });
    afterEach(() => store.sqlite.close());

    function insert(id: string, updatedAt: number, abandonedAt: number | null = null, empty = false) {
        store.sqlite.prepare(`INSERT INTO abandoned_checkouts
            (id, checkout_id, checkout_data, created_at, updated_at, abandoned_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(
                id, `session_${id}`, JSON.stringify({ cart: { items: empty ? [] : [{ id: "variant" }] } }),
                updatedAt, updatedAt, abandonedAt,
            );
    }

    it("marks only stale rows in bounded passes and preserves the first timestamp after resumption", async () => {
        insert("old_a", now - 7200);
        insert("old_b", now - 7200);
        insert("old_c", now - 3600);
        insert("active", now - 3599);
        insert("marked", now - 7200, now - 4000);

        await cleanupStaleAbandonedCheckouts(store.db, now, { limit: 2 });
        expect(store.sqlite.prepare("SELECT id, abandoned_at FROM abandoned_checkouts WHERE abandoned_at IS NOT NULL ORDER BY id").all())
            .toEqual([
                { id: "marked", abandoned_at: now - 4000 },
                { id: "old_a", abandoned_at: now },
                { id: "old_b", abandoned_at: now },
            ]);
        store.sqlite.prepare("UPDATE abandoned_checkouts SET updated_at = ? WHERE id = 'old_a'").run(now);
        await cleanupStaleAbandonedCheckouts(store.db, now, { limit: 2 });
        expect(store.sqlite.prepare("SELECT abandoned_at FROM abandoned_checkouts WHERE id = 'old_c'").get())
            .toEqual({ abandoned_at: now });
        await cleanupStaleAbandonedCheckouts(store.db, now + 7200, { limit: 2 });
        expect(store.sqlite.prepare("SELECT abandoned_at, updated_at FROM abandoned_checkouts WHERE id = 'old_a'").get())
            .toEqual({ abandoned_at: now, updated_at: now });
    });

    it("removes expired and empty snapshots before marking recoverable checkouts", async () => {
        insert("expired", now - 31 * 86400);
        insert("empty", now - 7200, null, true);
        insert("recoverable", now - 7200);
        await cleanupStaleAbandonedCheckouts(store.db, now, { limit: 5 });
        expect(store.sqlite.prepare("SELECT id, abandoned_at FROM abandoned_checkouts").all())
            .toEqual([{ id: "recoverable", abandoned_at: now }]);
    });
});
