// Segments on the real schema: every filter agrees with a plain reference
// evaluation over a seeded store (random definitions, both match modes),
// the list/tag/export surfaces use the same filters, and evaluation stays
// bounded on a large store: no order aggregation at read time, at most a
// third of D1's bound values for the largest definition, capped counts and
// primary-key membership checks.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database, D1_MAX_BOUND_PARAMETERS } from "@scalius/database/testing/sqlite-d1";
import { commerceCalendarDayBounds } from "@scalius/shared/commerce-time";
import {
    CUSTOMER_SEGMENT_CONDITIONS_MAX,
    CUSTOMER_SEGMENT_COUNT_CAP,
    CUSTOMER_SEGMENT_VALUES_MAX,
    customerSegmentDefinitionSchema,
    type CustomerSegmentCondition,
    type MarketingChannel,
} from "@scalius/shared/customer-marketing";
import { ConflictError, ValidationError } from "@scalius/core/errors";

import { buildCustomerCsvExport } from "./customer-export";
import {
    countSegmentMembers,
    createCustomerSegment,
    customerSegmentMembership,
    deleteCustomerSegment,
    listCustomerSegments,
    listSegmentMemberIds,
    parseSegmentDefinition,
    updateCustomerSegment,
} from "./customer-segments";
import { addTagsToCustomers, listCustomerTags, listStoreCustomerTags, removeTagsFromCustomers, setCustomerTags } from "./customer-tags";
import { listCustomers } from "./customers.service";

const NOW = 1_800_000_000;
const DAY = 86_400;
const CITIES = ["loc_dhaka", "loc_ctg", "loc_sylhet", null];
const ZONES = ["zone_a", "zone_b", null];
const TAGS = ["vip", "wholesale", "ঢাকা", "late payer", "eid"];

/** Deterministic PRNG (mulberry32). */
function random(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Facts {
    id: string;
    deleted: boolean;
    kind: "account" | "guest" | "merchant";
    city: string | null;
    zone: string | null;
    email: string | null;
    phone: string;
    createdAt: number;
    orders: Array<{ paid: number; at: number; status: string; deleted: boolean }>;
    tags: Set<string>;
    consents: Map<MarketingChannel, { state: string; contact: string }>;
    field: string | null;
}

function seedStore(sqlite: DatabaseSync, count: number, seed = 7): Facts[] {
    const next = random(seed);
    const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
    const facts: Facts[] = [];
    sqlite.exec(`INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type) VALUES ('cfd_tier00001', 'customer', 'custom', 'tier', 'Tier', 'single_line_text')`);
    const insertCustomer = sqlite.prepare(`INSERT INTO customers (id, name, phone, email, origin, account_claimed_at, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    // City and thana live on the default address of the address book (0113).
    const insertAddress = sqlite.prepare(`INSERT INTO customer_addresses (id, customer_id, is_default, country_code, line1, city, zone) VALUES (?, ?, 1, 'BD', 'House', ?, ?)`);
    const insertOrder = sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, customer_id, paid_amount_minor, created_at, deleted_at) VALUES (?, 'B', ?, 'House', 'c', 'z', ?, ?, ?, ?, ?)`);
    const insertTag = sqlite.prepare("INSERT INTO customer_tag_links (customer_id, tag) VALUES (?, ?)");
    const insertConsent = sqlite.prepare(`INSERT INTO customer_marketing_consents (customer_id, channel, state, contact, source, actor, subscribed_at, requested_at, confirmation_hash) VALUES (?, ?, ?, ?, 'admin', 'staff', ?, ?, ?)`);
    const insertField = sqlite.prepare("INSERT INTO custom_field_values (definition_id, owner_type, owner_id, value) VALUES ('cfd_tier00001', 'customer', ?, ?)");
    let orderSeq = 0;
    for (let index = 0; index < count; index += 1) {
        const id = `cust_${String(index).padStart(5, "0")}`;
        const kind = pick(["account", "guest", "guest", "merchant"] as const);
        const phone = `+88017${String(10_000_000 + index).slice(-8)}`;
        const email = next() < 0.6 ? `buyer${index}@example.com` : null;
        const fact: Facts = {
            id,
            deleted: next() < 0.05,
            kind,
            city: pick(CITIES),
            zone: pick(ZONES),
            email,
            phone,
            createdAt: NOW - Math.floor(next() * 400) * DAY,
            orders: [],
            tags: new Set(),
            consents: new Map(),
            field: next() < 0.3 ? pick(["gold", "silver"]) : null,
        };
        insertCustomer.run(id, `Customer ${index}`, phone, email, kind === "merchant" ? "merchant" : kind === "account" ? "account" : "order", kind === "account" ? 1 : null, fact.createdAt, fact.deleted ? 1 : null);
        if (fact.city || fact.zone) insertAddress.run(`caddr_${id}`, id, fact.city, fact.zone);
        const orderCount = Math.floor(next() * 5);
        for (let order = 0; order < orderCount; order += 1) {
            const entry = {
                paid: pick([0, 0, 50_000, 125_000, 300_000, -500]),
                at: NOW - Math.floor(next() * 365) * DAY,
                status: pick(["pending", "delivered", "cancelled", "incomplete"]),
                deleted: next() < 0.1,
            };
            fact.orders.push(entry);
            orderSeq += 1;
            insertOrder.run(`ord_${orderSeq}`, phone, entry.status, id, entry.paid, entry.at, entry.deleted ? 1 : null);
        }
        for (const tag of TAGS) {
            if (next() < 0.25) {
                fact.tags.add(tag);
                insertTag.run(id, tag);
            }
        }
        for (const channel of ["email", "sms", "whatsapp"] as const) {
            const contact = channel === "email" ? email : phone;
            if (!contact || next() < 0.5) continue;
            const state = pick(channel === "email" ? ["subscribed", "unsubscribed", "pending"] : ["subscribed", "unsubscribed"]);
            // Some consents cover an older address.
            const covered = next() < 0.15 ? `old-${contact}` : contact;
            fact.consents.set(channel, { state, contact: covered });
            insertConsent.run(id, channel, state, covered, state === "subscribed" ? 1 : null, state === "pending" ? 1 : null, state === "pending" ? `hash_${id}` : null);
        }
        if (fact.field) insertField.run(id, fact.field);
        facts.push(fact);
    }
    return facts;
}

function reference(facts: Facts, condition: CustomerSegmentCondition): boolean {
    const real = facts.orders.filter((order) => !order.deleted && order.status !== "incomplete");
    const spent = real.reduce((sum, order) => sum + Math.max(order.paid, 0), 0);
    const last = real.length ? Math.max(...real.map((order) => order.at)) : null;
    const first = real.length ? Math.min(...real.map((order) => order.at)) : null;
    const range = (value: number, input: { min?: number; max?: number }) =>
        (input.min === undefined || value >= input.min) && (input.max === undefined || value <= input.max);
    const date = (value: number | null, filter: Extract<CustomerSegmentCondition, { field: "last_order_date" }>["filter"]) => {
        if (value === null) return false;
        switch (filter.op) {
            case "within_last": return value >= NOW - filter.days * DAY;
            case "not_within_last": return value < NOW - filter.days * DAY;
            case "on_or_after": return value >= commerceCalendarDayBounds("Asia/Dhaka", filter.date).start;
            case "before": return value < commerceCalendarDayBounds("Asia/Dhaka", filter.date).start;
        }
    };
    switch (condition.field) {
        case "amount_spent": return range(spent, condition);
        case "orders_count": return range(real.length, condition);
        case "last_order_date": return date(last, condition.filter);
        case "first_order_date": return date(first, condition.filter);
        case "customer_since": return date(facts.createdAt, condition.filter);
        case "city":
        case "zone": {
            const value = condition.field === "city" ? facts.city : facts.zone;
            return condition.op === "in" ? value !== null && condition.ids.includes(value) : value === null || !condition.ids.includes(value);
        }
        case "tags":
            if (condition.op === "has_any") return condition.tags.some((tag) => facts.tags.has(tag));
            if (condition.op === "has_none") return !condition.tags.some((tag) => facts.tags.has(tag));
            return condition.tags.every((tag) => facts.tags.has(tag));
        case "marketing_consent": {
            const row = facts.consents.get(condition.channel);
            const current = condition.channel === "email" ? facts.email : facts.phone;
            const status = row && current && row.contact === current ? row.state : "not_subscribed";
            return status === condition.status;
        }
        case "customer_type": return condition.types.includes(facts.kind);
        case "custom_field":
            if (condition.op === "is_set") return facts.field !== null;
            if (condition.op === "is_not_set") return facts.field === null;
            return facts.field === condition.value;
    }
}

function randomCondition(next: () => number): CustomerSegmentCondition {
    const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
    const dateFilter = () => pick([
        { op: "within_last" as const, days: pick([7, 30, 90, 180]) },
        { op: "not_within_last" as const, days: pick([30, 90, 365]) },
        { op: "on_or_after" as const, date: pick(["2026-06-01", "2026-12-15"]) },
        { op: "before" as const, date: pick(["2026-06-01", "2026-12-15"]) },
    ]);
    const field = pick(["amount_spent", "orders_count", "last_order_date", "first_order_date", "customer_since", "city", "zone", "tags", "marketing_consent", "customer_type", "custom_field"] as const);
    switch (field) {
        case "amount_spent": return pick([{ field, min: 50_000 }, { field, max: 125_000 }, { field, min: 50_000, max: 300_000 }]);
        case "orders_count": return pick([{ field, min: 2 }, { field, max: 0 }, { field, min: 1, max: 2 }]);
        case "last_order_date":
        case "first_order_date":
        case "customer_since": return { field, filter: dateFilter() };
        case "city": return { field, op: pick(["in", "not_in"] as const), ids: ["loc_dhaka", pick(["loc_ctg", "loc_sylhet"])] };
        case "zone": return { field, op: pick(["in", "not_in"] as const), ids: [pick(["zone_a", "zone_b"])] };
        case "tags": return { field, op: pick(["has_any", "has_all", "has_none"] as const), tags: [pick(TAGS), pick(TAGS)] };
        case "marketing_consent": return { field, channel: pick(["email", "sms", "whatsapp"] as const), status: pick(["subscribed", "pending", "unsubscribed", "not_subscribed"] as const) };
        case "customer_type": return { field, types: [pick(["account", "guest", "merchant"] as const)] };
        case "custom_field": return pick([
            { field, definitionId: "cfd_tier00001", op: "equals" as const, value: "gold" },
            { field, definitionId: "cfd_tier00001", op: "is_set" as const },
            { field, definitionId: "cfd_tier00001", op: "is_not_set" as const },
        ]);
    }
}

describe("customer segments", () => {
    let sqlite: DatabaseSync;
    let db: Database;
    let boundCounts: number[];

    beforeEach(() => {
        boundCounts = [];
        ({ sqlite, db } = createSqliteD1Database({ onQuery: (_query, values) => boundCounts.push(values.length) }));
    });
    afterEach(() => sqlite.close());

    it("matches a reference evaluation for random definitions over a seeded store", async () => {
        const facts = seedStore(sqlite, 400);
        const next = random(42);
        for (let round = 0; round < 120; round += 1) {
            const definition = customerSegmentDefinitionSchema.parse({
                match: next() < 0.7 ? "all" : "any",
                conditions: Array.from({ length: 1 + Math.floor(next() * 3) }, () => randomCondition(next)),
            });
            const expected = facts
                .filter((customer) => !customer.deleted)
                .filter((customer) => definition.match === "all"
                    ? definition.conditions.every((condition) => reference(customer, condition))
                    : definition.conditions.some((condition) => reference(customer, condition)))
                .map((customer) => customer.id)
                .sort();
            const members: string[] = [];
            let afterId: string | null = null;
            for (;;) {
                const page = await listSegmentMemberIds(db, definition, { afterId, limit: 97, nowSeconds: NOW });
                members.push(...page);
                if (page.length < 97) break;
                afterId = page.at(-1)!;
            }
            expect(members, JSON.stringify(definition)).toEqual(expected);
            expect(await countSegmentMembers(db, definition, { nowSeconds: NOW, timeZone: "Asia/Dhaka" })).toEqual({ count: expected.length, capped: false });
            const probe = facts[Math.floor(next() * facts.length)]!;
            const membership = await customerSegmentMembership(db, probe.id, [{ id: "seg_probe", definition }], { nowSeconds: NOW, timeZone: "Asia/Dhaka" });
            expect(membership.has("seg_probe"), `${probe.id} ${JSON.stringify(definition)}`).toBe(expected.includes(probe.id));
        }
    }, 120_000);

    it("filters the customer list, sorts by stored order facts and exports the same customers", async () => {
        const facts = seedStore(sqlite, 120, 3);
        const vip = facts.filter((customer) => !customer.deleted && customer.tags.has("vip"));
        const page = await listCustomers(db, { limit: 100, filters: { tag: "vip" }, sort: "totalSpent", order: "desc" });
        expect(page.pagination.total).toBe(vip.length);
        const spent = page.customers.map((customer) => customer.totalSpent);
        expect(spent).toEqual([...spent].sort((left, right) => right - left));
        const subscribedSms = facts.filter((customer) => !customer.deleted && customer.consents.get("sms")?.state === "subscribed" && customer.consents.get("sms")?.contact === customer.phone);
        expect((await listCustomers(db, { limit: 100, filters: { subscribed: "sms" } })).pagination.total).toBe(subscribedSms.length);

        const exported = await buildCustomerCsvExport(db, { filters: { subscribed: "sms" } });
        expect(exported.rowCount).toBe(subscribedSms.length);
        expect(exported.limited).toBe(false);
        const [header, firstLine] = exported.body.replace(/^\uFEFF/, "").split("\n");
        expect(header).toContain('"SMS marketing"');
        expect(firstLine).toContain('"subscribed"');
        // Phones stay data; formula-looking cells are neutralised.
        expect(firstLine).toMatch(/"\+8801\d+"/);
        sqlite.exec(`UPDATE customers SET name = '=HYPERLINK("x")' WHERE id = '${subscribedSms[0]!.id}'`);
        expect((await buildCustomerCsvExport(db, { ids: [subscribedSms[0]!.id] })).body).toContain(`"'=HYPERLINK(""x"")"`);
        expect((await buildCustomerCsvExport(db, { filters: { subscribed: "sms" }, maxRows: 3 })).limited).toBe(subscribedSms.length > 3);
    });

    it("stays bounded on a large store", async () => {
        sqlite.exec(`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${CUSTOMER_SEGMENT_COUNT_CAP + 2_000})
            INSERT INTO customers (id, name, phone, origin, created_at)
            SELECT printf('cust_%07d', i), 'B', printf('+88017%08d', i), 'order', ${NOW} FROM n;
            INSERT INTO customer_addresses (id, customer_id, is_default, country_code, line1, city)
            SELECT 'caddr_' || id, id, 1, 'BD', 'House', CASE WHEN CAST(substr(id, 6) AS INTEGER) % 3 = 0 THEN 'loc_dhaka' ELSE 'loc_ctg' END FROM customers WHERE id LIKE 'cust_%';
            INSERT INTO customer_tag_links (customer_id, tag) SELECT id, 'vip' FROM customers WHERE id LIKE 'cust_000%';
        `);
        const everyone = customerSegmentDefinitionSchema.parse({ conditions: [{ field: "orders_count", min: 0 }] });
        expect(await countSegmentMembers(db, everyone)).toEqual({ count: CUSTOMER_SEGMENT_COUNT_CAP, capped: true });

        // The largest definition: 12 conditions with 50 values each.
        const values = Array.from({ length: CUSTOMER_SEGMENT_VALUES_MAX }, (_, index) => `loc_${index}`);
        const largest = customerSegmentDefinitionSchema.parse({
            conditions: Array.from({ length: CUSTOMER_SEGMENT_CONDITIONS_MAX }, (_, index) => index % 2
                ? { field: "tags", op: "has_all", tags: values.map((value) => `t${value}`) }
                : { field: "city", op: "not_in", ids: values }),
        });
        boundCounts = [];
        await countSegmentMembers(db, largest);
        await listSegmentMemberIds(db, largest, { limit: 500 });
        await customerSegmentMembership(db, "cust_0000001", [{ id: "a", definition: largest }, { id: "b", definition: everyone }]);
        expect(Math.max(...boundCounts)).toBeLessThanOrEqual(Math.floor(D1_MAX_BOUND_PARAMETERS / 2));

        // No order aggregation at read time: segment SQL reads stored facts only.
        const captured: string[] = [];
        const probe = createSqliteD1Database({ sqlite, onQuery: (query) => captured.push(query) });
        await customerSegmentMembership(probe.db, "cust_0000001", [{ id: "a", definition: largest }]);
        expect(captured.join("\n")).not.toMatch(/from\s+"orders"/i);
        const explained = sqlite.prepare(`EXPLAIN QUERY PLAN ${captured[0]}`).all() as Array<{ detail: string }>;
        expect(explained.map((row) => row.detail).join(" | ")).toMatch(/SEARCH customers USING INDEX sqlite_autoindex_customers_1 \(id=\?\)|SEARCH customers USING INTEGER PRIMARY KEY|SEARCH customers USING PRIMARY KEY/);
        const tagged = customerSegmentDefinitionSchema.parse({ conditions: [{ field: "tags", op: "has_any", tags: ["vip"] }] });
        expect((await countSegmentMembers(db, tagged)).count).toBe(9_999);
    }, 120_000);

    it("saves, renames, protects and soft-deletes segments", async () => {
        seedStore(sqlite, 20, 11);
        const definition = { conditions: [{ field: "amount_spent", min: 1 }] };
        const created = await createCustomerSegment(db, { name: " Big  spenders ", definition }, "usr_1");
        expect(created).toMatchObject({ name: "Big spenders", revision: 1, promotionCount: 0 });
        await expect(createCustomerSegment(db, { name: "big spenders", definition }, null)).rejects.toBeInstanceOf(ConflictError);
        await expect(createCustomerSegment(db, { name: "Bad", definition: { conditions: [] } }, null)).rejects.toBeInstanceOf(ValidationError);
        await expect(parseSegmentDefinition(db, { conditions: [{ field: "custom_field", definitionId: "cfd_missing01", op: "is_set" }] })).rejects.toThrow(/does not exist/);
        await expect(updateCustomerSegment(db, created.id, { expectedRevision: 9, name: "X" })).rejects.toBeInstanceOf(ConflictError);
        const renamed = await updateCustomerSegment(db, created.id, { expectedRevision: 1, name: "Top buyers" });
        expect(renamed.revision).toBe(2);
        sqlite.exec(`INSERT INTO promotions (id, name, method, status) VALUES ('promo_vip', 'VIP', 'automatic', 'active');
            INSERT INTO promotion_customer_segments (promotion_id, segment_id) VALUES ('promo_vip', '${created.id}');`);
        expect((await listCustomerSegments(db))[0]).toMatchObject({ id: created.id, promotionCount: 1 });
        await expect(deleteCustomerSegment(db, created.id)).rejects.toBeInstanceOf(ConflictError);
        sqlite.exec("UPDATE promotions SET status = 'archived' WHERE id = 'promo_vip'");
        await deleteCustomerSegment(db, created.id);
        expect(await listCustomerSegments(db)).toEqual([]);
        // The archived promotion keeps a valid reference; the name is free again.
        expect(sqlite.prepare("SELECT count(*) AS n FROM promotion_customer_segments").get()).toEqual({ n: 1 });
        await createCustomerSegment(db, { name: "Top buyers", definition }, null);
    });

    it("normalises tags and bulk-adds and removes them within the per-customer limit", async () => {
        seedStore(sqlite, 5, 13);
        sqlite.exec("DELETE FROM customer_tag_links");
        expect(await setCustomerTags(db, "cust_00000", ["  VIP ", "vip", "Late   payer", "ঢাকা"])).toEqual(["late payer", "vip", "ঢাকা"]);
        await expect(setCustomerTags(db, "cust_00000", ["x".repeat(41)])).rejects.toBeInstanceOf(ValidationError);
        await addTagsToCustomers(db, { customerIds: ["cust_00000", "cust_00001", "cust_missing"], tags: ["Eid", "vip"] });
        expect(await listCustomerTags(db, "cust_00001")).toEqual(["eid", "vip"]);
        expect(await listCustomerTags(db, "cust_00000")).toEqual(["eid", "late payer", "vip", "ঢাকা"]);
        await removeTagsFromCustomers(db, { customerIds: ["cust_00000", "cust_00001"], tags: ["VIP"] });
        expect(await listCustomerTags(db, "cust_00001")).toEqual(["eid"]);
        expect((await listStoreCustomerTags(db, { query: "ঢা" }))).toEqual([{ tag: "ঢাকা", customers: 1 }]);
        // A customer at the limit is left as it is.
        await setCustomerTags(db, "cust_00002", Array.from({ length: 50 }, (_, index) => `t${index}`));
        await addTagsToCustomers(db, { customerIds: ["cust_00002"], tags: ["one more"] });
        expect(await listCustomerTags(db, "cust_00002")).toHaveLength(50);
        await expect(addTagsToCustomers(db, { customerIds: [], tags: ["x"] })).rejects.toBeInstanceOf(ValidationError);
    });
});
