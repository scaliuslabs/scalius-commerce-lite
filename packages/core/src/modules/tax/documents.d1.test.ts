// App tax-provider documents on the real migrated schema (migration 0168):
// the writes that owe a document write its command in their own transaction
// (an app-provider snapshot's insert, the move to cancelled, a confirmed
// refund payment), the runner sends each once with the provider's idempotency
// key, retries with backoff, holds a void or refund until the commit is done,
// and an order on the system provider writes nothing.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ProviderError } from "@scalius/shared/plugins/providers";

import type { AppProviders, BoundProvider } from "../../integrations/provider-port";
import { drainTaxDocumentCommands, processTaxDocumentCommand, processTaxDocumentCommandsForOrder } from "./documents";

const LEVY = "acme.levy:levy";

let sqlite: DatabaseSync;
let db: Database;
let calls: Array<{ operation: string; input: Record<string, unknown> }>;
let failures: Error[];
let operations: Set<string>;

const apps: AppProviders = {
    async resolve(kind, id) {
        if (kind !== "tax" || id !== LEVY) return { provider: null, issue: "not installed" } as never;
        const provider: Record<string, unknown> = { id, label: "Acme Levy", calculate: async () => { throw new Error("unused"); } };
        for (const operation of operations) {
            provider[operation] = async (input: Record<string, unknown>) => {
                calls.push({ operation, input });
                const failure = failures.shift();
                if (failure) throw failure;
                return { documentId: `doc-${operation}-${String(input.orderId)}` };
            };
        }
        return { provider: provider as unknown as BoundProvider<"tax">, issue: null } as never;
    },
};

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    calls = [];
    failures = [];
    operations = new Set(["commit", "void", "refund"]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
});

/** An order of 132.00 with 22.00 tax and its tax snapshot, as the checkout commit writes them in one batch. */
function commitOrder(orderId: string, providerId = LEVY, calculationId: string | null = `calc-${orderId}`) {
    sqlite.exec("BEGIN");
    sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, currency_code,
      currency_decimal_places, subtotal_amount_minor, tax_amount_minor, total_amount_minor, status, payment_method, payment_status, paid_amount_minor)
      VALUES (?, 'Buyer', '+447700900123', 'London', 'city_1', 'zone_1', 'USD', 2, 11000, 2200, 13200, 'pending', 'stripe', 'paid', 13200)`).run(orderId);
    sqlite.prepare(`INSERT INTO order_tax_snapshots (order_id, currency_code, decimal_places, display_label, prices_include_tax,
      shipping_taxed, settings_version, calculation_version, destination_snapshot, rate_snapshot, provider_id, provider_calculation_id)
      VALUES (?, 'USD', 2, 'Tax', 0, 1, 1, 'tax-v1', '{}', '[]', ?, ?)`).run(orderId, providerId, calculationId);
    sqlite.exec("COMMIT");
}

function refundPayment(orderId: string, paymentId: string, amountMinor: number, status: "pending" | "refunded") {
    sqlite.prepare(`INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
      VALUES (?, ?, ?, 'USD', 'stripe', 'refund', ?)`).run(paymentId, orderId, amountMinor, status);
}

const commands = () => sqlite.prepare(`SELECT id, operation, status, attempts, document_id, last_error, amount_minor, tax_minor
  FROM tax_document_commands ORDER BY created_at, id`).all();
const makeDue = () => sqlite.exec("UPDATE tax_document_commands SET next_attempt_at = 0 WHERE status IN ('pending', 'failed')");

describe("app tax-provider document commands", () => {
    it("commits once per order, retrying a failed call with backoff under the same key", async () => {
        commitOrder("ord_1");
        expect(commands()).toMatchObject([{ id: "tax-commit:ord_1", operation: "commit", status: "pending", attempts: 0 }]);

        failures.push(new ProviderError("retryable", "The provider is busy.", { code: "levy.busy" }));
        await expect(processTaxDocumentCommandsForOrder(db, "ord_1", apps)).resolves.toEqual(["failed"]);
        expect(commands()).toMatchObject([{ status: "failed", attempts: 1, last_error: "levy.busy" }]);
        // Backing off: not due yet, so nothing is sent.
        await expect(drainTaxDocumentCommands(db, apps, { limit: 10 })).resolves.toMatchObject({ scanned: 0 });

        makeDue();
        await expect(drainTaxDocumentCommands(db, apps, { limit: 10 })).resolves.toMatchObject({ scanned: 1, done: 1 });
        expect(commands()).toMatchObject([{ status: "done", attempts: 2, document_id: "doc-commit-ord_1", last_error: null }]);
        expect(calls.map(({ operation, input }) => [operation, input])).toEqual([
            ["commit", { calculationId: "calc-ord_1", orderId: "ord_1", idempotencyKey: "tax-commit:ord_1" }],
            ["commit", { calculationId: "calc-ord_1", orderId: "ord_1", idempotencyKey: "tax-commit:ord_1" }],
        ]);
        // Done is done: a replayed drain sends nothing.
        await expect(processTaxDocumentCommand(db, "tax-commit:ord_1", apps)).resolves.toBe("busy");
        expect(calls).toHaveLength(2);
    });

    it("voids a cancelled order and reverses each refund's share of tax, only after the commit", async () => {
        commitOrder("ord_2");
        // A refund recorded as settled at once, and one confirmed later by its provider.
        refundPayment("ord_2", "pay_refund_a", 6_600, "refunded");
        refundPayment("ord_2", "pay_refund_b", 1_320, "pending");
        sqlite.exec("UPDATE order_payments SET status = 'refunded' WHERE id = 'pay_refund_b'");
        sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_2'");
        // A status write that is not a new cancellation writes nothing more.
        sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_2'");
        expect(commands()).toMatchObject([
            { id: "tax-commit:ord_2", status: "pending" },
            { id: "tax-refund:ord_2:pay_refund_a", operation: "refund", amount_minor: 6_600, tax_minor: 1_100 },
            { id: "tax-refund:ord_2:pay_refund_b", operation: "refund", amount_minor: 1_320, tax_minor: 220 },
            { id: "tax-void:ord_2", operation: "void", status: "pending" },
        ]);

        // The reversals wait for the document without spending attempts.
        await expect(processTaxDocumentCommand(db, "tax-void:ord_2", apps)).resolves.toBe("deferred");
        await expect(processTaxDocumentCommand(db, "tax-refund:ord_2:pay_refund_a", apps)).resolves.toBe("deferred");
        expect(calls).toEqual([]);
        expect(commands()).toMatchObject([
            { status: "pending" },
            { status: "pending", attempts: 0, last_error: "awaiting_commit" },
            { status: "pending" },
            { status: "pending", attempts: 0, last_error: "awaiting_commit" },
        ]);

        makeDue();
        await expect(processTaxDocumentCommandsForOrder(db, "ord_2", apps)).resolves.toEqual(["done", "done", "done", "done"]);
        // The commit goes first; then the reversals.
        expect(calls.map(({ operation }) => operation).sort()).toEqual(["commit", "refund", "refund", "void"]);
        expect(calls[0]!.operation).toBe("commit");
        expect(calls.find(({ input }) => input.refundId === "pay_refund_a")?.input).toEqual({
            calculationId: "calc-ord_2", orderId: "ord_2", idempotencyKey: "tax-refund:ord_2:pay_refund_a",
            refundId: "pay_refund_a", amountMinor: 6_600, taxMinor: 1_100,
        });
        expect(calls.find(({ operation }) => operation === "void")?.input).toEqual({
            calculationId: "calc-ord_2", orderId: "ord_2", idempotencyKey: "tax-void:ord_2",
        });
        expect(new Set((commands() as Array<{ status: string }>).map(({ status }) => status))).toEqual(new Set(["done"]));
    });

    it("writes nothing for an order on the system provider, or without a provider calculation", async () => {
        commitOrder("ord_system", "system", null);
        refundPayment("ord_system", "pay_refund_system", 1_000, "refunded");
        sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_system'");
        expect(commands()).toEqual([]);
        await expect(processTaxDocumentCommandsForOrder(db, "ord_system", apps)).resolves.toEqual([]);
    });

    it("rolls back with the write that owes it", async () => {
        sqlite.exec("BEGIN");
        sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, currency_code,
          currency_decimal_places, subtotal_amount_minor, tax_amount_minor, total_amount_minor, status, payment_method, payment_status)
          VALUES ('ord_lost', 'Buyer', '+447700900123', 'London', 'city_1', 'zone_1', 'USD', 2, 11000, 2200, 13200, 'pending', 'stripe', 'paid')`).run();
        sqlite.prepare(`INSERT INTO order_tax_snapshots (order_id, currency_code, decimal_places, display_label, prices_include_tax,
          shipping_taxed, settings_version, calculation_version, destination_snapshot, rate_snapshot, provider_id, provider_calculation_id)
          VALUES ('ord_lost', 'USD', 2, 'Tax', 0, 1, 1, 'tax-v1', '{}', '[]', ?, 'calc-lost')`).run(LEVY);
        sqlite.exec("ROLLBACK");
        expect(commands()).toEqual([]);
    });

    it("gives up on a declined call, skips an operation the app does not offer, and waits for an uninstalled app", async () => {
        commitOrder("ord_3");
        failures.push(new ProviderError("declined", "Unknown calculation.", { code: "levy.unknown_calculation" }));
        await expect(processTaxDocumentCommandsForOrder(db, "ord_3", apps)).resolves.toEqual(["dead"]);
        // Its reversal cannot follow a document that never existed.
        sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_3'");
        await expect(processTaxDocumentCommandsForOrder(db, "ord_3", apps)).resolves.toEqual(["dead"]);
        expect(commands()).toMatchObject([
            { id: "tax-commit:ord_3", status: "dead", last_error: "levy.unknown_calculation" },
            { id: "tax-void:ord_3", status: "dead", last_error: "commit_not_done" },
        ]);

        operations = new Set(["commit"]);
        commitOrder("ord_4");
        await processTaxDocumentCommandsForOrder(db, "ord_4", apps);
        refundPayment("ord_4", "pay_refund_4", 1_000, "refunded");
        await expect(processTaxDocumentCommandsForOrder(db, "ord_4", apps)).resolves.toEqual(["skipped"]);
        expect(commands()).toContainEqual(expect.objectContaining({ id: "tax-refund:ord_4:pay_refund_4", status: "skipped", last_error: "not_supported" }));

        commitOrder("ord_5", "acme.gone:levy");
        await expect(processTaxDocumentCommandsForOrder(db, "ord_5", apps)).resolves.toEqual(["failed"]);
        expect(commands()).toContainEqual(expect.objectContaining({ id: "tax-commit:ord_5", status: "failed", last_error: "provider_unavailable" }));
    });
});
