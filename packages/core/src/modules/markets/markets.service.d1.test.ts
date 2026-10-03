// Markets as the dashboard edits them (MARKETS-DESIGN D4): one revision per
// market aggregate, one market per country, one subfolder per presence, the
// backup market always active at the root with the store's price increment,
// and the active presence matrix buyers and orders resolve against.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { withDependencyScope } from "../../cache-deps";
import { createMarket, deleteMarket, getMarket, listMarkets, resetBackupPriceIncrement, updateMarket } from "./markets.service";
import { readMarketMatrix } from "./matrix";
import { orderMarketId, orderMarketIdSql } from "./order-market";
import { readStoreCurrency } from "./pricing";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
});
afterEach(() => sqlite.close());

const india = { name: "India", status: "active" as const, countries: ["IN", "np"], presence: { value: "en-in", locale: "en" } };

describe("markets", () => {
    it("lists the backup market migration 0112 created from today's store", async () => {
        expect(await listMarkets(db)).toEqual([expect.objectContaining({
            id: "mkt_backup",
            handle: "bangladesh",
            name: "Bangladesh",
            status: "active",
            isBackup: true,
            revision: 1,
            countries: ["BD"],
            presence: { value: "", locale: "en" },
            currencyCode: "BDT",
            priceIncrementMinor: 100,
            priceIncrementInherited: false,
            hasOrders: false,
        })]);
    });

    it("creates a market in the shop currency at the backup market's increment", async () => {
        const created = await createMarket(db, india);
        expect(created).toMatchObject({
            handle: "india",
            status: "active",
            isBackup: false,
            revision: 1,
            countries: ["IN", "NP"],
            presence: { value: "en-in", locale: "en" },
            currencyCode: "BDT",
            priceIncrementMinor: 100,
            priceIncrementInherited: true,
        });
        expect(created.id).toMatch(/^mkt_/);
        // A second market from the same name gets the next free handle.
        await expect(createMarket(db, { ...india, countries: ["LK"], presence: null })).resolves.toMatchObject({ handle: "india-2" });
    });

    it("keeps each country in one market and each subfolder for one market", async () => {
        await createMarket(db, india);
        await expect(createMarket(db, { ...india, name: "Nepal", countries: ["NP"], presence: null }))
            .rejects.toThrow(/NP from India/);
        await expect(createMarket(db, { ...india, name: "Bangladesh 2", countries: ["BD"], presence: null }))
            .rejects.toBeInstanceOf(ConflictError);
        await expect(createMarket(db, { ...india, name: "Elsewhere", countries: ["LK"] }))
            .rejects.toThrow(/en-in is India's subfolder/);
        await expect(createMarket(db, { ...india, name: "Nowhere", countries: [] })).rejects.toBeInstanceOf(ValidationError);
        await expect(createMarket(db, { ...india, name: "Odd", countries: ["ZZ"], presence: null })).rejects.toThrow(/Unknown country codes: ZZ/);
        await expect(createMarket(db, { ...india, name: "Odd", countries: ["LK"], presence: { value: "hi-lk", locale: "en" } }))
            .rejects.toBeInstanceOf(ValidationError);
        await expect(createMarket(db, { ...india, name: "Odd", countries: ["LK"], presence: { value: "", locale: "en" } }))
            .rejects.toBeInstanceOf(ValidationError);
        await expect(createMarket(db, { ...india, name: "Odd", handle: "Has Spaces", countries: ["LK"], presence: null }))
            .rejects.toBeInstanceOf(ValidationError);
    });

    it("updates under the revision the editor loaded, once per save", async () => {
        const created = await createMarket(db, india);
        const updated = await updateMarket(db, created.id, {
            expectedRevision: 1,
            name: "South Asia",
            countries: ["IN", "LK"],
            presence: { value: "hi-in", locale: "hi" },
            status: "draft",
        });
        expect(updated.market).toMatchObject({ name: "South Asia", revision: 2, countries: ["IN", "LK"], presence: { value: "hi-in", locale: "hi" }, status: "draft" });
        expect(updated.priceIncrementChanged).toBe(false);
        await expect(updateMarket(db, created.id, { expectedRevision: 1, name: "Stale" })).rejects.toBeInstanceOf(ConflictError);
        // Removing a country frees it for another market.
        await expect(createMarket(db, { ...india, name: "Nepal", countries: ["NP"], presence: { value: "ne-np", locale: "ne" } }))
            .resolves.toMatchObject({ countries: ["NP"] });
        // No presence is allowed: the market still decides checkout for its countries.
        await expect(updateMarket(db, created.id, { expectedRevision: 2, presence: null })).resolves.toMatchObject({ market: { presence: null, revision: 3 } });
    });

    it("keeps the backup market active at the root, and gives only it a price increment", async () => {
        const created = await createMarket(db, india);
        await expect(updateMarket(db, "mkt_backup", { expectedRevision: 1, status: "draft" })).rejects.toThrow(/always active/);
        await expect(updateMarket(db, "mkt_backup", { expectedRevision: 1, presence: { value: "bn-bd", locale: "bn" } })).rejects.toThrow(/root URL/);
        await expect(updateMarket(db, created.id, { expectedRevision: 1, priceIncrementMinor: 1 })).rejects.toThrow(/shop currency/);
        await expect(updateMarket(db, "mkt_backup", { expectedRevision: 1, priceIncrementMinor: 10 })).rejects.toBeInstanceOf(ValidationError);
        await expect(deleteMarket(db, "mkt_backup", 1)).rejects.toThrow(/can't be deleted/);

        const language = await updateMarket(db, "mkt_backup", { expectedRevision: 1, presence: { value: "", locale: "bn" } });
        expect(language.market.presence).toEqual({ value: "", locale: "bn" });
        const paisa = await updateMarket(db, "mkt_backup", { expectedRevision: 2, priceIncrementMinor: 1 });
        expect(paisa.priceIncrementChanged).toBe(true);
        expect(paisa.market.priceIncrementMinor).toBe(1);
        await expect(readStoreCurrency(db)).resolves.toMatchObject({ code: "BDT", priceIncrementMinor: 1 });
        // Every other market prices at it.
        await expect(getMarket(db, created.id)).resolves.toMatchObject({ priceIncrementMinor: 1, priceIncrementInherited: true });
        const unchanged = await updateMarket(db, "mkt_backup", { expectedRevision: 3, priceIncrementMinor: 1 });
        expect(unchanged.priceIncrementChanged).toBe(false);
    });

    it("resets the backup's increment to a new shop currency's default", async () => {
        await updateMarket(db, "mkt_backup", { expectedRevision: 1, priceIncrementMinor: 1 });
        sqlite.exec(`INSERT INTO settings (id, key, value, type, category) VALUES ('cur', 'document', '{"currencyCode":"USD","currencySymbol":"$"}', 'json', 'currency')`);
        expect(await resetBackupPriceIncrement(db, "USD", 1)).toBe(false);
        await expect(readStoreCurrency(db)).resolves.toMatchObject({ code: "USD", priceIncrementMinor: 1 });
        sqlite.exec(`UPDATE settings SET value = '{"currencyCode":"BDT","currencySymbol":"৳"}' WHERE id = 'cur'`);
        expect(await resetBackupPriceIncrement(db, "BDT", 1)).toBe(true);
        await expect(readStoreCurrency(db)).resolves.toMatchObject({ code: "BDT", priceIncrementMinor: 100 });
    });

    it("deletes a market without orders, and keeps one with orders", async () => {
        const kept = await createMarket(db, india);
        const removed = await createMarket(db, { ...india, name: "Sri Lanka", countries: ["LK"], presence: null });
        await expect(deleteMarket(db, removed.id, 2)).rejects.toBeInstanceOf(ConflictError);
        await deleteMarket(db, removed.id, 1);
        expect((await listMarkets(db)).map((market) => market.id)).toEqual(["mkt_backup", kept.id]);
        sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, market_id)
            VALUES ('ord_in', 'Asha', '+8801711111113', 'House 3', 'city_1', 'zone_1', 'pending', ?)`).run(kept.id);
        await expect(getMarket(db, kept.id)).resolves.toMatchObject({ hasOrders: true });
        await expect(deleteMarket(db, kept.id, 1)).rejects.toThrow(/has orders/);
    });
});

describe("the presence matrix", () => {
    it("holds active markets only, backup first, and declares mk:*", async () => {
        const created = await createMarket(db, india);
        await createMarket(db, { ...india, name: "Draft", status: "draft", countries: ["LK"], presence: { value: "si-lk", locale: "si" } });
        const read = await withDependencyScope(() => readMarketMatrix(db), { strict: true });
        expect(read.value).toEqual({ markets: [
            { id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", isBackup: true, countries: ["BD"], presences: [{ value: "", locale: "en" }] },
            { id: created.id, handle: "india", name: "India", isBackup: false, countries: ["IN", "NP"], presences: [{ value: "en-in", locale: "en" }] },
        ] });
        expect(read.dependencies.keys).toContain("mk:*");
        expect(read.dependencies.coarseTables).toEqual([]);
    });

    it("places an order in the shipping country's active market, else the backup market (the pure rule and its SQL twin agree)", async () => {
        const both = async (country?: string) => {
            const [row] = await db.select({ id: orderMarketIdSql(country ?? "BD") }).from(sql`(SELECT 1 AS one) AS probe`);
            const pure = orderMarketId(await readMarketMatrix(db), country ?? "BD");
            expect(row!.id, country ?? "BD").toBe(pure);
            return pure;
        };
        expect(await both()).toBe("mkt_backup");
        const bangladesh = await createMarket(db, { name: "Dhaka", status: "draft", countries: ["LK"], presence: null });
        // Bangladesh moves out of the backup market into a draft market: still the backup's until it is active.
        await updateMarket(db, "mkt_backup", { expectedRevision: 1, countries: [] });
        await updateMarket(db, bangladesh.id, { expectedRevision: 1, countries: ["BD"] });
        expect(await both()).toBe("mkt_backup");
        await updateMarket(db, bangladesh.id, { expectedRevision: 2, status: "active" });
        expect(await both()).toBe(bangladesh.id);
        expect(await both("US")).toBe("mkt_backup");
        expect(await both("LK")).toBe("mkt_backup");
        // Not an ISO code: the backup market, and nothing reaches the SQL.
        expect(await both("bd'--")).toBe("mkt_backup");
        // An order that ships nothing has no shipping country: the backup market.
        const [none] = await db.select({ id: orderMarketIdSql(null) }).from(sql`(SELECT 1 AS one) AS probe`);
        expect(none!.id).toBe("mkt_backup");
        expect(orderMarketId(await readMarketMatrix(db), null)).toBe("mkt_backup");
    });
});
