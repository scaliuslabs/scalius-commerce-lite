// Promotions limited to customer segments, on the real migrated schema (D1
// and Turso): only a signed-in member gets one (a guest never does, whatever
// phone they type), membership is read live at quote and commit time, the
// links are part of the revisioned rule, and public offer reads never list
// a limited promotion.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createMigratedSqlite, createSqliteD1Database, createSqliteTursoDatabase } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "@scalius/core/errors";

import { createCustomerSegment, deleteCustomerSegment, listCustomerSegments } from "../customers/customer-segments";
import { planHomePromotions } from "../storefront/homepage-sections";
import type { StorefrontDiscountCart } from "./checkout-snapshot";
import {
    listProductBuyGetOffers,
    quoteStorefrontDiscount,
    verifyPromotionCheckoutSnapshot,
    type PromotionCheckoutBuyer,
    type StorefrontDiscountInput,
    type StorefrontDiscountQuote,
} from "./promotions.checkout";
import { activatePromotion } from "./promotions.lifecycle";
import { PromotionRevisionConflictError } from "./promotions.revision";
import {
    archivePromotionDraft,
    createPromotionDraft,
    getPromotionAggregate,
    listPromotionDrafts,
    previewPersistedPromotion,
    updatePromotionDraft,
} from "./promotions.service";
import type { CreatePromotionDraftInput } from "./promotions.validation";

const NOW = 1_900_000_000;
const SIGN_IN = "This code is for selected customers. Sign in with an eligible account.";
const NOT_ONE_OF_THEM = "This code is for selected customers, and your account isn't one of them.";
const VIP_PHONE = "+8801700000001";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

function openStore(provider: "d1" | "turso"): Database {
    sqlite = createMigratedSqlite({ provider });
    sqlite.exec(`
        INSERT INTO products (id, name, slug, price_minor) VALUES
            ('prod_tee', 'Tee', 'tee', 50000),
            ('prod_cap', 'Cap', 'cap', 20000);
        INSERT INTO customers (id, name, phone, origin, account_claimed_at, phone_verified_at) VALUES
            ('cust_vip', 'Vip', '${VIP_PHONE}', 'account', 1700000000, 1700000000),
            ('cust_other', 'Other', '+8801700000002', 'account', 1700000000, 1700000000);
        INSERT INTO customer_tag_links (customer_id, tag) VALUES ('cust_vip', 'vip');
    `);
    return provider === "d1" ? createSqliteD1Database({ sqlite }).db : createSqliteTursoDatabase(sqlite);
}

const cart: StorefrontDiscountCart = {
    currencyCode: "BDT",
    priceIncrementMinor: 100,
    lines: [
        { id: "cart:0:var_tee", productId: "prod_tee", variantId: "var_tee", unitPriceMinor: 50_000, quantity: 2 },
        { id: "cart:1:var_cap", productId: "prod_cap", variantId: "var_cap", unitPriceMinor: 20_000, quantity: 1 },
    ],
    shippingAmountMinor: 6_000,
};

const orderOff = (basisPoints: number) => ({
    kind: "percentage_off" as const, target: "order" as const, allocation: "once" as const, config: { basisPoints },
});
const buyTeeGetCap = {
    kind: "percentage_off" as const,
    target: "line" as const,
    allocation: "across" as const,
    config: { basisPoints: 10_000, productIds: ["prod_cap"], getQuantity: 1, buy: { quantity: 1, productIds: ["prod_tee"] } },
};

type Rule = Partial<CreatePromotionDraftInput> & Pick<CreatePromotionDraftInput, "effects" | "name">;

async function live(db: Database, rule: Rule) {
    const created = await createPromotionDraft(db, { method: rule.codes ? "code" : "automatic", ...rule });
    return activatePromotion(db, created.id, created.revision, NOW - 3_600);
}

async function segment(db: Database, name: string, definition: unknown): Promise<string> {
    return (await createCustomerSegment(db, { name, definition }, null)).id;
}
const tagged = (tag: string) => ({ conditions: [{ field: "tags", op: "has_any", tags: [tag] }] });

const quote = (db: Database, codes: string[], overrides: Partial<StorefrontDiscountInput> = {}) =>
    quoteStorefrontDiscount(db, { codes, cart, evaluatedAtEpochSeconds: NOW, ...overrides });
const applied = (result: StorefrontDiscountQuote) => result.applied?.discounts.map(({ promotionName }) => promotionName) ?? [];
const signedIn = (customerId: string) => ({ customerId, segmentCustomerId: customerId });

describe.each(["d1", "turso"] as const)("promotions limited to customer segments (%s)", (provider) => {
    const links = (promotionId: string) => (sqlite!.prepare(
        "SELECT segment_id AS id FROM promotion_customer_segments WHERE promotion_id = ? ORDER BY segment_id",
    ).all(promotionId) as Array<{ id: string }>).map(({ id }) => id);

    it("gives a limited code to a signed-in member only, never to a guest with the member's phone", async () => {
        const db = openStore(provider);
        const vip = await segment(db, "VIP", tagged("vip"));
        await live(db, { name: "VIP 10", codes: [{ code: "VIP10" }], customerSegmentIds: [vip], effects: [orderOff(1_000)] });

        expect((await quote(db, ["vip10"], signedIn("cust_vip"))).applied?.totalDiscountMinor).toBe(12_000);

        const other = await quote(db, ["VIP10"], signedIn("cust_other"));
        expect(other.applied).toBeNull();
        expect(other.rejectedCodes).toEqual([{ code: "VIP10", reason: "unavailable", message: NOT_ONE_OF_THEM }]);

        // A typed phone, or the member's record matched from it, is still a guest.
        for (const guest of [{ customerPhone: VIP_PHONE }, { customerId: "cust_vip", customerPhone: VIP_PHONE }]) {
            const result = await quote(db, ["VIP10"], guest);
            expect(result.applied).toBeNull();
            expect(result.rejectedCodes).toEqual([{ code: "VIP10", reason: "unavailable", message: SIGN_IN }]);
        }
    });

    it("asks a guest to sign in, not for a phone, for a limited one-use code", async () => {
        const db = openStore(provider);
        const vip = await segment(db, "VIP", tagged("vip"));
        await live(db, {
            name: "VIP once",
            codes: [{ code: "VIPONCE" }],
            maxRedemptionsPerCustomer: 1,
            customerSegmentIds: [vip],
            effects: [orderOff(1_000)],
        });
        expect((await quote(db, ["VIPONCE"])).rejectedCodes).toEqual([{ code: "VIPONCE", reason: "unavailable", message: SIGN_IN }]);
        expect((await quote(db, ["VIPONCE"], signedIn("cust_vip"))).applied?.totalDiscountMinor).toBe(12_000);
    });

    it("lets a limited automatic discount compete only for members of any of its segments", async () => {
        const db = openStore(provider);
        const nobody = await segment(db, "Big spenders", { conditions: [{ field: "orders_count", min: 5 }] });
        const vip = await segment(db, "VIP", tagged("vip"));
        await live(db, { name: "VIP 20%", customerSegmentIds: [nobody, vip], effects: [orderOff(2_000)] });
        await live(db, { name: "Everyone 5%", effects: [orderOff(500)] });

        expect(applied(await quote(db, [], signedIn("cust_vip")))).toEqual(["VIP 20%"]);
        expect(applied(await quote(db, [], signedIn("cust_other")))).toEqual(["Everyone 5%"]);
        expect(applied(await quote(db, [], { customerPhone: VIP_PHONE }))).toEqual(["Everyone 5%"]);

        // Membership is read live: losing the tag closes it at once.
        sqlite!.exec("DELETE FROM customer_tag_links WHERE customer_id = 'cust_vip'");
        expect(applied(await quote(db, [], signedIn("cust_vip")))).toEqual(["Everyone 5%"]);
    });

    it("matches nobody once its only segment is deleted", async () => {
        const db = openStore(provider);
        const vip = await segment(db, "VIP", tagged("vip"));
        await live(db, { name: "VIP 20%", customerSegmentIds: [vip], effects: [orderOff(2_000)] });
        expect(applied(await quote(db, [], signedIn("cust_vip")))).toEqual(["VIP 20%"]);
        // Deleting is refused while a live discount uses it; a deleted one fails closed anyway.
        await expect(deleteCustomerSegment(db, vip)).rejects.toThrow("Discounts are limited to this segment");
        sqlite!.prepare("UPDATE customer_segments SET deleted_at = unixepoch() WHERE id = ?").run(vip);
        expect(applied(await quote(db, [], signedIn("cust_vip")))).toEqual([]);
    });

    it("re-checks membership at commit: a real change conflicts, the same buyer never does", async () => {
        const db = openStore(provider);
        const vip = await segment(db, "VIP", tagged("vip"));
        await live(db, { name: "VIP 20%", customerSegmentIds: [vip], effects: [orderOff(2_000)] });
        await live(db, { name: "Everyone 5%", effects: [orderOff(500)] });
        const verify = (prepared: StorefrontDiscountQuote, buyer: PromotionCheckoutBuyer) =>
            verifyPromotionCheckoutSnapshot(db, prepared.snapshot!, buyer, NOW);

        const member = await quote(db, [], signedIn("cust_vip"));
        await expect(verify(member, signedIn("cust_vip"))).resolves.toEqual(member.applied);

        // A guest whose verified phone links the order to the member's account
        // commits as the guest it was quoted as: no false "discount changed".
        const guest = await quote(db, [], { customerPhone: VIP_PHONE });
        expect(applied(guest)).toEqual(["Everyone 5%"]);
        await expect(verify(guest, { customerId: "cust_vip", segmentCustomerId: null })).resolves.toEqual(guest.applied);
        await expect(verify(guest, signedIn("cust_vip"))).rejects.toThrow("changed while you were checking out");

        sqlite!.exec("DELETE FROM customer_tag_links WHERE customer_id = 'cust_vip'");
        await expect(verify(member, signedIn("cust_vip"))).rejects.toThrow("changed while you were checking out");
    });

    it("writes the links inside the revisioned rule and refuses unknown, deleted or repeated segments", async () => {
        const db = openStore(provider);
        const vip = await segment(db, "VIP", tagged("vip"));
        const spenders = await segment(db, "Big spenders", { conditions: [{ field: "orders_count", min: 5 }] });
        const rule = { name: "VIP", method: "code" as const, codes: [{ code: "VIP" }], effects: [orderOff(1_000)] };

        const created = await createPromotionDraft(db, { ...rule, customerSegmentIds: [vip] });
        expect(links(created.id)).toEqual([vip]);
        expect((await getPromotionAggregate(db, created.id))?.customerSegmentIds).toEqual([vip]);
        expect((await getPromotionAggregate(db, created.id))).not.toHaveProperty("customerInSegment");

        const both = await updatePromotionDraft(db, created.id, { ...rule, expectedRevision: 1, customerSegmentIds: [spenders, vip] });
        expect(both.revision).toBe(2);
        expect(links(created.id)).toEqual([spenders, vip].sort());
        expect((await listPromotionDrafts(db)).find(({ id }) => id === created.id)?.customerSegmentIds).toEqual([spenders, vip].sort());
        expect((await listCustomerSegments(db)).map(({ name, promotionCount }) => [name, promotionCount]).sort())
            .toEqual([["Big spenders", 1], ["VIP", 1]]);

        // A stale editor changes nothing.
        await expect(updatePromotionDraft(db, created.id, { ...rule, expectedRevision: 1, customerSegmentIds: [] }))
            .rejects.toBeInstanceOf(PromotionRevisionConflictError);
        expect(links(created.id)).toEqual([spenders, vip].sort());

        const cleared = await updatePromotionDraft(db, created.id, { ...rule, expectedRevision: 2, customerSegmentIds: [] });
        expect(cleared.revision).toBe(3);
        expect(links(created.id)).toEqual([]);

        await expect(createPromotionDraft(db, { ...rule, codes: [{ code: "GONE" }], customerSegmentIds: ["seg_missing0001"] }))
            .rejects.toBeInstanceOf(ValidationError);
        await deleteCustomerSegment(db, spenders);
        await expect(updatePromotionDraft(db, created.id, { ...rule, expectedRevision: 3, customerSegmentIds: [vip, spenders] }))
            .rejects.toBeInstanceOf(ValidationError);
        expect(links(created.id)).toEqual([]);
        await expect(createPromotionDraft(db, { ...rule, codes: [{ code: "TWICE" }], customerSegmentIds: [vip, vip] }))
            .rejects.toThrow("Choose each customer segment once.");
        await expect(createPromotionDraft(db, { ...rule, codes: [{ code: "SIX" }], customerSegmentIds: ["a", "b", "c", "d", "e", "f"] }))
            .rejects.toThrow();

        // A discount holds its segment until it is archived.
        const holder = await createPromotionDraft(db, { ...rule, codes: [{ code: "VIP2" }], customerSegmentIds: [vip] });
        await expect(deleteCustomerSegment(db, vip)).rejects.toThrow("Discounts are limited to this segment");
        await archivePromotionDraft(db, holder.id, holder.revision);
        await expect(deleteCustomerSegment(db, vip)).resolves.toBeUndefined();
    });

    it("previews as a chosen customer, and as a guest without one", async () => {
        const db = openStore(provider);
        const vip = await segment(db, "VIP", tagged("vip"));
        const promotion = await live(db, { name: "VIP 20%", customerSegmentIds: [vip], effects: [orderOff(2_000)] });
        const evaluationCart = { ...cart, submittedCodes: [], evaluatedAtEpochSeconds: NOW };
        const preview = (customerId: string | null) => previewPersistedPromotion(db, {
            promotionId: promotion.id,
            expectedRevision: promotion.revision,
            cart: evaluationCart,
            customerId,
        });
        expect((await preview("cust_vip")).applied?.totalDiscountMinor).toBe(24_000);
        expect((await preview("cust_other")).rejected).toEqual([{ promotionId: promotion.id, reason: "customer_not_eligible" }]);
        expect((await preview(null)).rejected).toEqual([{ promotionId: promotion.id, reason: "customer_not_eligible" }]);
    });

    it("keeps limited promotions off public offers and deal countdowns", async () => {
        const db = openStore(provider);
        const vip = await segment(db, "VIP", tagged("vip"));
        const limited = await live(db, {
            name: "VIP tee gift", customerSegmentIds: [vip], endsAtEpochSeconds: NOW + 86_400, effects: [buyTeeGetCap],
        });
        expect(await listProductBuyGetOffers(db, "prod_tee", { code: "BDT", priceIncrementMinor: 100 }, NOW)).toEqual([]);
        // A member still gets it at checkout.
        expect(applied(await quote(db, [], signedIn("cust_vip")))).toEqual(["VIP tee gift"]);

        const open = await live(db, { name: "Tee gift", endsAtEpochSeconds: NOW + 86_400, effects: [buyTeeGetCap] });
        expect((await listProductBuyGetOffers(db, "prod_tee", { code: "BDT", priceIncrementMinor: 100 }, NOW)).map(({ title }) => title)).toEqual(["Tee gift"]);

        const plan = planHomePromotions(db, [limited.id, open.id], NOW * 1_000);
        const rows = await plan.statements[0]!;
        expect(plan.resolve([rows], 0).map(({ id }) => id)).toEqual([open.id]);
    });
});
