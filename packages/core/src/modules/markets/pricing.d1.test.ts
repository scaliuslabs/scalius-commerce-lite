// The store's price increment (MARKETS-DESIGN D1, D4) has two readers: the
// backup market in TypeScript (`readStoreCurrency`) and the scalar subquery
// catalogue reads embed (`storePriceIncrementSql`). They must agree for every
// shop currency and every stored increment, valid or not, on D1 and TursoDB.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { cacheClock } from "@scalius/database/schema";
import {
    createMigratedSqlite,
    createSqliteD1Database,
    createSqliteTursoDatabase,
} from "@scalius/database/testing/sqlite-d1";
import { withDependencyScope } from "../../cache-deps";
import { readStoreCurrency, storeCurrencyFromSql, storePriceIncrementSql } from "./pricing";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

const DOCUMENTS: Array<[string, string | null, Record<number, number>]> = [
    // Stored increment -> what pricing uses.
    ["no document: a BDT store", null, { 1: 1, 10: 100, 100: 100, 1000: 100 }],
    ["BDT", JSON.stringify({ currencyCode: "BDT", currencySymbol: "৳" }), { 1: 1, 10: 100, 100: 100, 1000: 100 }],
    ["USD", JSON.stringify({ currencyCode: "usd", currencySymbol: "$" }), { 1: 1, 10: 1, 100: 100, 1000: 1 }],
    ["JPY has no whole-unit choice above 1", JSON.stringify({ currencyCode: "JPY", currencySymbol: "¥" }), { 1: 1, 10: 1, 100: 1, 1000: 1 }],
    ["KWD", JSON.stringify({ currencyCode: "KWD", currencySymbol: "KD" }), { 1: 1, 10: 1, 100: 1, 1000: 1000 }],
    ["an unsupported code is BDT", JSON.stringify({ currencyCode: "USDT", currencySymbol: "₮" }), { 1: 1, 10: 100, 100: 100, 1000: 100 }],
    ["an unreadable document is BDT", "not json", { 1: 1, 10: 100, 100: 100, 1000: 100 }],
];

describe.each(["d1", "turso"] as const)("store price increment (%s)", (provider) => {
    it.each(DOCUMENTS)("%s", async (_label, document, expected) => {
        sqlite = createMigratedSqlite({ provider });
        const db = provider === "d1" ? createSqliteD1Database({ sqlite }).db : createSqliteTursoDatabase(sqlite);
        if (document !== null) {
            sqlite.prepare(`INSERT INTO settings (id, key, value, type, category)
                VALUES ('currency_doc', 'document', ?, 'json', 'currency')`).run(document);
        }
        for (const [stored, uses] of Object.entries(expected)) {
            sqlite.prepare("UPDATE markets SET price_increment_minor = ? WHERE id = 'mkt_backup'").run(Number(stored));
            const fromMarket = (await readStoreCurrency(db)).priceIncrementMinor;
            // Any one-row table: the subquery reads the settings and markets rows itself.
            const row = await db.select({ increment: storePriceIncrementSql() }).from(cacheClock).limit(1).get();
            expect(fromMarket, `stored ${stored}`).toBe(uses);
            expect(Number(row?.increment), `stored ${stored}`).toBe(uses);
            const code = document && document !== "not json" ? JSON.parse(document).currencyCode : null;
            expect(storeCurrencyFromSql(code, row?.increment).priceIncrementMinor, `stored ${stored}`).toBe(uses);
        }
    });
});

describe("the increment's cache dependencies", () => {
    it("declare the currency document and only the backup market's pricing key", async () => {
        sqlite = createMigratedSqlite();
        const { db } = createSqliteD1Database({ sqlite });
        const sqlRead = await withDependencyScope(
            () => db.select({ increment: storePriceIncrementSql() }).from(cacheClock).limit(1).get(),
            { strict: true },
        );
        expect(sqlRead.dependencies.keys).toEqual(expect.arrayContaining(["mk:backup", "set:currency:document"]));
        expect(sqlRead.dependencies.coarseTables).toEqual([]);
        expect(sqlRead.dependencies.keys).not.toContain("mk:*");
        const typed = await withDependencyScope(() => readStoreCurrency(db), { strict: true });
        expect(typed.value).toEqual({ code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100, symbol: "৳" });
        expect(typed.dependencies.keys).toEqual(expect.arrayContaining(["mk:backup", "set:currency:document"]));
        expect(typed.dependencies.coarseTables).toEqual([]);
    });
});
