// Test-only fixture (never import from Worker code): a migrated SQLite store
// with a physical product, a service and a gift-card product, real gift cards,
// and the storefront checkout path the route takes (one authority read,
// prepare, the reviewed-tender check, one commit batch) with gift cards.
import type { DatabaseSync } from "node:sqlite";

import { safeBatch, type Database } from "@scalius/database/client";
import { createSqliteD1Database, type SqliteD1Statement } from "@scalius/database/testing/sqlite-d1";
import {
    buildGiftCardIssueStatements,
    deriveGiftCardKeys,
    sealGiftCardApplyHandle,
} from "../modules/gift-cards";
import { buildCheckoutAttemptIdentity, createAtomicCheckoutAttempt } from "../modules/checkout/attempts";
import { loadStorefrontCheckoutAuthority } from "../modules/checkout/authority";
import { commitStorefrontOrderPayload } from "../modules/checkout/commit";
import {
    assertStorefrontGiftCardTenderReviewed,
    createStorefrontOrder,
    createTrustedStorefrontCheckoutPolicySnapshot,
} from "../modules/checkout/prepare";
import type { CreateStorefrontOrderInput, CreateStorefrontOrderResult } from "../modules/orders/types";
import type { AtomicCheckoutAttempt } from "../modules/checkout/attempts";

export const TEST_MASTER_SECRET = "test-master-secret-for-gift-card-handles-0123456789";
const TEST_CREDENTIAL_KEY = "test-credential-encryption-key-for-gift-cards-0123456789";

type Line = CreateStorefrontOrderInput["items"][number];

export const line = (productId: string, variantId: string, quantity: number, price: number, properties?: Line["properties"]): Line =>
    ({ productId, variantId, quantity, price, properties });

export const DELIVERY = {
    shippingAddress: "House 1, Road 2, Gulshan",
    city: "city_1",
    zone: "zone_1",
    shippingMethodId: "m_ship",
} as const;

export interface PreparedGiftCardCheckout {
    data: CreateStorefrontOrderInput;
    attempt: AtomicCheckoutAttempt;
    result: CreateStorefrontOrderResult;
}

export interface GiftCardCheckoutFixture {
    sqlite: DatabaseSync;
    db: Database;
    /** Every batch the database ran since the last `resetBatches()`. */
    batches: Array<readonly SqliteD1Statement[]>;
    resetBatches(): void;
    /**
     * Makes the next batch whose statements match fail before it runs (a
     * crash mid-flow); it fires once.
     */
    failNextBatch(matches: (statements: readonly SqliteD1Statement[]) => boolean): void;
    one<T = Record<string, unknown>>(query: string, ...params: Array<string | number>): T;
    all<T = Record<string, unknown>>(query: string, ...params: Array<string | number>): T[];
    /** A real active card funded by its `issue` transaction, and a live apply handle. */
    issueCard(amountMinor: number, id?: string): Promise<{ giftCardId: string; handle: string }>;
    balance(giftCardId: string): number;
    /** Prepare as the route does, then the reviewed-tender check (no write). */
    prepare(overrides: Partial<CreateStorefrontOrderInput> & { items: Line[] }, options?: { partialPaymentEnabled?: boolean }): Promise<PreparedGiftCardCheckout>;
    commit(prepared: PreparedGiftCardCheckout): Promise<void>;
    checkout(overrides: Partial<CreateStorefrontOrderInput> & { items: Line[] }, options?: { partialPaymentEnabled?: boolean }): Promise<CreateStorefrontOrderResult>;
    close(): void;
}

export function createGiftCardCheckoutFixture(seedSql = ""): GiftCardCheckoutFixture {
    const batches: Array<readonly SqliteD1Statement[]> = [];
    const pendingFailures: Array<(statements: readonly SqliteD1Statement[]) => boolean> = [];
    const { sqlite, db } = createSqliteD1Database({
        beforeBatch(_sqlite, statements) {
            batches.push(statements);
            const failure = pendingFailures.findIndex((matches) => matches(statements));
            if (failure >= 0) {
                pendingFailures.splice(failure, 1);
                throw new Error("Injected batch failure");
            }
        },
    });
    sqlite.exec(`
        INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
        VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
        INSERT INTO shipping_methods (id, name, fee_minor, kind) VALUES ('m_ship', 'Standard', 6000, 'delivery');
        INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
          ('p_mug', 'Mug', 'mug', 30000, 1),
          ('p_svc', 'Setup', 'setup', 50000, 1);
        INSERT INTO products (id, name, slug, price_minor, is_active, is_gift_card) VALUES
          ('p_gc', 'Gift card', 'gift-card', 50000, 1, 1);
        INSERT INTO product_variants
          (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
        VALUES
          ('v_mug', 'p_mug', 'MUG-1', 30000, 200, 0, 0, 1, 1, 'physical'),
          ('v_svc', 'p_svc', 'SETUP-1', 50000, 0, 0, 0, 1, 0, 'service'),
          ('v_gc', 'p_gc', 'GC-500', 50000, 0, 0, 0, 1, 0, 'digital');
        ${seedSql}
    `);

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;
    const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).all(...params) as T[];

    async function prepare(
        overrides: Partial<CreateStorefrontOrderInput> & { items: Line[] },
        options: { partialPaymentEnabled?: boolean } = {},
    ): Promise<PreparedGiftCardCheckout> {
        const data: CreateStorefrontOrderInput = {
            checkoutRequestId: `request_${crypto.randomUUID()}`,
            expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
            customerName: "Gift Buyer",
            customerPhone: "+8801712345678",
            customerEmail: null,
            shippingAddress: null,
            city: null,
            zone: null,
            area: null,
            notes: null,
            discountCodes: [],
            shippingCharge: 0,
            shippingMethodId: null,
            paymentMethod: "cod",
            inventoryPool: "regular",
            ...overrides,
        };
        const authority = await loadStorefrontCheckoutAuthority(db, {
            items: data.items,
            inventoryPool: data.inventoryPool,
            city: data.city,
            zone: data.zone,
            area: data.area,
            shippingMethodId: data.shippingMethodId,
            customerPhone: data.customerPhone,
        });
        const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
        const result = await createStorefrontOrder(
            db,
            data,
            "https://shop.example.com/api/v1/orders",
            { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
            authority.cartValidation,
            authority.deliveryPreflight,
            undefined,
            { code: "BDT", decimalPlaces: 2 },
            createTrustedStorefrontCheckoutPolicySnapshot({
                partialPaymentEnabled: options.partialPaymentEnabled ?? false,
                authorityRevision: authority.authorityRevision,
                orderCreatedNotificationEnabled: false,
                metaPurchaseEnabled: false,
            }),
            authority.taxAuthority,
            { masterSecret: TEST_MASTER_SECRET },
        );
        assertStorefrontGiftCardTenderReviewed(result.giftCardTender, data.expectedAmountDueMinor);
        return { data, attempt, result };
    }

    async function commit({ attempt, result }: PreparedGiftCardCheckout): Promise<void> {
        await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
    }

    return {
        sqlite,
        db,
        batches,
        resetBatches: () => {
            batches.length = 0;
        },
        failNextBatch: (matches) => {
            pendingFailures.push(matches);
        },
        one,
        all,
        async issueCard(amountMinor, id) {
            const giftCardId = id ?? `gc_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
            const keys = await deriveGiftCardKeys(TEST_CREDENTIAL_KEY);
            const built = await buildGiftCardIssueStatements(db, keys, {
                id: giftCardId,
                source: "manual",
                amountMinor,
                currencyCode: "BDT",
                expiresAt: null,
                customerId: null,
                recipient: null,
                message: null,
                note: null,
                issuedByUserId: null,
                idempotencyKey: `issue:manual:${giftCardId}`,
                actor: { type: "admin", id: null },
            });
            await safeBatch(db, built.statements as never);
            const { handle } = await sealGiftCardApplyHandle(TEST_MASTER_SECRET, giftCardId);
            return { giftCardId, handle };
        },
        balance(giftCardId) {
            return Number(one<{ b: number }>("SELECT balance_minor AS b FROM gift_cards WHERE id = ?", giftCardId).b);
        },
        prepare,
        commit,
        async checkout(overrides, options) {
            const prepared = await prepare(overrides, options);
            batches.length = 0;
            await commit(prepared);
            return prepared.result;
        },
        close: () => sqlite.close(),
    };
}
