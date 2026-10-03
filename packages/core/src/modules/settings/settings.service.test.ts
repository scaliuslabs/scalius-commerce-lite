import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { getCurrencyConfig } from "./settings.service";

type Harness = ReturnType<typeof createSqliteD1Database>;

function storeDocument(harness: Harness, category: string, value: unknown) {
    harness.sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES (?, 'document', ?, 'json', ?)")
        .run(`${category}_doc`, JSON.stringify(value), category);
    return harness.db;
}

describe("buyer currency config", () => {
    it("normalizes a supported persisted code and derives its precision", async () => {
        const db = storeDocument(createSqliteD1Database(), "currency", {
            currencyCode: " jpy ",
            currencySymbol: "¥",
        });

        await expect(getCurrencyConfig(db)).resolves.toEqual({
            code: "JPY",
            symbol: "¥",
            decimalPlaces: 0,
        });
    });

    it("fails closed to BDT when the persisted code is unsupported", async () => {
        const db = storeDocument(createSqliteD1Database(), "currency", {
            currencyCode: "USDT",
            currencySymbol: "₿",
        });

        await expect(getCurrencyConfig(db)).resolves.toEqual({
            code: "BDT",
            symbol: "৳",
            decimalPlaces: 2,
        });
    });
});
