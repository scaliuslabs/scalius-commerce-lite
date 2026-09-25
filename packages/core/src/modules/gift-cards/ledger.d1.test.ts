// G1 on the real migrated schema: a card's balance is the sum of its
// append-only transactions, never below zero, and only transactions move it.
// Raw-SQL attempts to bypass the ledger fail; a random property run of every
// transaction kind keeps the projection exact.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { deriveGiftCardKeys, type GiftCardKeys } from "./crypto";
import { buildGiftCardIssueStatements } from "./issue";
import { buildGiftCardTransactionInsert, buildGiftCardTransactionInsertOnce, isGiftCardLedgerError } from "./ledger";

const TEST_KEY = "test-credential-encryption-key-0123456789abcdef";

describe("gift-card ledger (G1)", () => {
    let sqlite: DatabaseSync;
    let db: Database;
    let keys: GiftCardKeys;

    beforeEach(async () => {
        ({ sqlite, db } = createSqliteD1Database());
        keys = await deriveGiftCardKeys(TEST_KEY);
    });
    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;

    async function issue(id: string, amountMinor: number, extra: { expiresAt?: number | null } = {}) {
        const built = await buildGiftCardIssueStatements(db, keys, {
            id,
            source: "manual",
            amountMinor,
            currencyCode: "BDT",
            expiresAt: extra.expiresAt ?? null,
            customerId: null,
            recipient: null,
            message: null,
            note: null,
            issuedByUserId: null,
            idempotencyKey: `issue:manual:${id}`,
            actor: { type: "admin", id: null },
        });
        await safeBatch(db, built.statements as never);
        return built;
    }

    const balance = (id: string) => one<{ b: number }>("SELECT balance_minor AS b FROM gift_cards WHERE id = ?", id).b;
    const ledgerSum = (id: string) =>
        one<{ s: number }>("SELECT coalesce(sum(amount_minor), 0) AS s FROM gift_card_transactions WHERE gift_card_id = ?", id).s;

    async function move(id: string, kind: "redeem" | "release" | "refund" | "adjust", amountMinor: number, key: string) {
        await safeBatch(db, [buildGiftCardTransactionInsert(db, {
            giftCardId: id,
            kind,
            amountMinor,
            idempotencyKey: key,
            actor: { type: "system", id: null },
            reason: kind === "adjust" ? "test" : null,
        })] as never);
    }

    it("funds a new card only through its issue transaction", async () => {
        await issue("gc_ledger_0001", 50_000);
        expect(balance("gc_ledger_0001")).toBe(50_000);
        expect(ledgerSum("gc_ledger_0001")).toBe(50_000);
        expect(one("SELECT kind, amount_minor, balance_after_minor FROM gift_card_transactions WHERE gift_card_id = ?", "gc_ledger_0001"))
            .toEqual({ kind: "issue", amount_minor: 50_000, balance_after_minor: 50_000 });
    });

    it("refuses raw writes that bypass the ledger", async () => {
        await issue("gc_ledger_0002", 10_000);
        expect(() => sqlite.exec("UPDATE gift_cards SET balance_minor = 99999 WHERE id = 'gc_ledger_0002'")).toThrow();
        expect(() => sqlite.exec("UPDATE gift_card_transactions SET amount_minor = 1")).toThrow(/append-only/);
        expect(() => sqlite.exec("DELETE FROM gift_card_transactions")).toThrow(/append-only/);
        expect(() => sqlite.exec("DELETE FROM gift_cards")).toThrow(/durable/);
        expect(() => sqlite.exec("UPDATE gift_cards SET code_last4 = 'ZZZZ' WHERE id = 'gc_ledger_0002'")).toThrow();
        expect(() => sqlite.exec(`
            INSERT INTO gift_cards (id, code_hash, code_ciphertext, code_last4, currency_code, initial_amount_minor, balance_minor, source)
            VALUES ('gc_ledger_raw1', 'h', 'c', 'ABCD', 'BDT', 100, 100, 'manual')
        `)).toThrow();
        expect(balance("gc_ledger_0002")).toBe(10_000);
    });

    it("refuses an overdraft and leaves the balance unchanged", async () => {
        await issue("gc_ledger_0003", 10_000);
        await move("gc_ledger_0003", "redeem", -6_000, "redeem:o1:gc_ledger_0003");
        let failure: unknown;
        try {
            await move("gc_ledger_0003", "redeem", -6_000, "redeem:o2:gc_ledger_0003");
        } catch (error) {
            failure = error;
        }
        expect(isGiftCardLedgerError(failure)).toBe(true);
        expect(balance("gc_ledger_0003")).toBe(4_000);
        await expect(move("gc_ledger_0003", "adjust", -4_001, "adjust:a1")).rejects.toThrow();
        expect(balance("gc_ledger_0003")).toBe(4_000);
    });

    it("refuses redeeming a disabled or expired card but still accepts credits", async () => {
        await issue("gc_ledger_0004", 10_000);
        sqlite.exec("UPDATE gift_cards SET status = 'disabled' WHERE id = 'gc_ledger_0004'");
        const disabled = await move("gc_ledger_0004", "redeem", -1_000, "redeem:o3:x").catch((error: unknown) => error);
        expect(isGiftCardLedgerError(disabled)).toBe(true);
        await move("gc_ledger_0004", "refund", 500, "refund:r1");
        expect(balance("gc_ledger_0004")).toBe(10_500);

        await issue("gc_ledger_0005", 10_000, { expiresAt: Math.floor(Date.now() / 1000) + 3600 });
        sqlite.exec("UPDATE gift_cards SET expires_at = unixepoch() - 1 WHERE id = 'gc_ledger_0005'");
        const expired = await move("gc_ledger_0005", "redeem", -1_000, "redeem:o4:x").catch((error: unknown) => error);
        expect(isGiftCardLedgerError(expired)).toBe(true);
        expect(balance("gc_ledger_0005")).toBe(10_000);
    });

    it("makes a repeated idempotency key a no-op with insertOnce and a failure otherwise", async () => {
        await issue("gc_ledger_0006", 10_000);
        await move("gc_ledger_0006", "redeem", -3_000, "redeem:o5:gc_ledger_0006");
        const release = () => safeBatch(db, [buildGiftCardTransactionInsertOnce(db, {
            giftCardId: "gc_ledger_0006",
            kind: "release",
            amountMinor: 3_000,
            idempotencyKey: "release:o5:gc_ledger_0006",
            actor: { type: "system", id: null },
        })] as never);
        await release();
        await release();
        expect(balance("gc_ledger_0006")).toBe(10_000);
        await expect(move("gc_ledger_0006", "redeem", -3_000, "redeem:o5:gc_ledger_0006")).rejects.toThrow();
        expect(balance("gc_ledger_0006")).toBe(10_000);
    });

    it("keeps balance = Σ transactions ≥ 0 across a random run of every kind (property)", async () => {
        let seed = 20260925;
        const random = () => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed / 2_147_483_648;
        };
        const cards = ["gc_prop_000001", "gc_prop_000002", "gc_prop_000003"];
        const model = new Map<string, number>();
        for (const id of cards) {
            const amount = 1_000 + Math.floor(random() * 50) * 100;
            await issue(id, amount);
            model.set(id, amount);
        }
        const kinds = ["redeem", "release", "refund", "adjust"] as const;
        for (let step = 0; step < 150; step += 1) {
            const id = cards[Math.floor(random() * cards.length)]!;
            const kind = kinds[Math.floor(random() * kinds.length)]!;
            const size = (1 + Math.floor(random() * 40)) * 100;
            const amount = kind === "redeem" ? -size : kind === "adjust" && random() < 0.5 ? -size : size;
            const expected = model.get(id)! + amount;
            const outcome = await move(id, kind, amount, `prop:${step}`).then(() => "ok", (error: unknown) => error);
            if (expected < 0) {
                expect(isGiftCardLedgerError(outcome) || outcome instanceof Error).toBe(true);
            } else {
                expect(outcome).toBe("ok");
                model.set(id, expected);
            }
            expect(balance(id)).toBe(model.get(id));
        }
        for (const id of cards) {
            expect(balance(id)).toBe(ledgerSum(id));
            expect(balance(id)).toBeGreaterThanOrEqual(0);
            const running = sqlite.prepare(
                "SELECT amount_minor, balance_after_minor FROM gift_card_transactions WHERE gift_card_id = ? ORDER BY rowid",
            ).all(id) as Array<{ amount_minor: number; balance_after_minor: number }>;
            let sum = 0;
            for (const row of running) {
                sum += row.amount_minor;
                expect(row.balance_after_minor).toBe(sum);
            }
        }
    });
});
