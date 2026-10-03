// The store's price increment (MARKETS-DESIGN D1) has two readers: the
// settings document in TypeScript (`priceIncrementOf`) and the scalar
// subquery catalogue reads embed (`storePriceIncrementSql`). They must agree
// for every stored document, valid or not, on D1 and TursoDB alike.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { cacheClock } from "@scalius/database/schema";
import {
    createMigratedSqlite,
    createSqliteD1Database,
    createSqliteTursoDatabase,
} from "@scalius/database/testing/sqlite-d1";
import { getCurrencyConfig } from "./settings.service";
import { storeCurrencyFromSql, storePriceIncrementSql } from "./store-money";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

const DOCUMENTS: Array<[string, string | null, number]> = [
    ["no document: a BDT store, whole taka", null, 100],
    ["BDT without a saved increment", JSON.stringify({ currencyCode: "BDT", currencySymbol: "৳" }), 100],
    ["BDT in paisa", JSON.stringify({ currencyCode: "BDT", currencySymbol: "৳", priceIncrementMinor: 1 }), 1],
    ["BDT in whole taka, saved", JSON.stringify({ currencyCode: "BDT", currencySymbol: "৳", priceIncrementMinor: 100 }), 100],
    ["BDT with an increment that is not a choice", JSON.stringify({ currencyCode: "BDT", currencySymbol: "৳", priceIncrementMinor: 10 }), 100],
    ["USD in cents by default", JSON.stringify({ currencyCode: "usd", currencySymbol: "$" }), 1],
    ["USD in whole dollars", JSON.stringify({ currencyCode: "USD", currencySymbol: "$", priceIncrementMinor: 100 }), 100],
    ["JPY has no whole-unit choice above 1", JSON.stringify({ currencyCode: "JPY", currencySymbol: "¥", priceIncrementMinor: 100 }), 1],
    ["KWD in whole dinars", JSON.stringify({ currencyCode: "KWD", currencySymbol: "KD", priceIncrementMinor: 1000 }), 1000],
    ["KWD refuses a two-decimal whole unit", JSON.stringify({ currencyCode: "KWD", currencySymbol: "KD", priceIncrementMinor: 100 }), 1],
    ["an unsupported code falls back to BDT", JSON.stringify({ currencyCode: "USDT", currencySymbol: "₮", priceIncrementMinor: 1 }), 100],
    ["a string increment is not one", JSON.stringify({ currencyCode: "BDT", currencySymbol: "৳", priceIncrementMinor: "1" }), 100],
    ["an unreadable document is the default", "not json", 100],
];

describe.each(["d1", "turso"] as const)("store price increment (%s)", (provider) => {
    it.each(DOCUMENTS)("%s", async (_label, document, expected) => {
        sqlite = createMigratedSqlite({ provider });
        const db = provider === "d1" ? createSqliteD1Database({ sqlite }).db : createSqliteTursoDatabase(sqlite);
        if (document !== null) {
            sqlite.prepare(`INSERT INTO settings (id, key, value, type, category)
                VALUES ('currency_doc', 'document', ?, 'json', 'currency')`).run(document);
        }
        const fromDocument = (await getCurrencyConfig(db)).priceIncrementMinor;
        // Any one-row table: the subquery reads the settings row itself.
        const row = await db.select({ increment: storePriceIncrementSql() }).from(cacheClock).limit(1).get();
        expect(fromDocument).toBe(expected);
        expect(Number(row?.increment)).toBe(expected);
        expect(storeCurrencyFromSql(JSON.parse(document && document !== "not json" ? document : "{}").currencyCode, row?.increment)
            .priceIncrementMinor).toBe(expected);
    });
});
