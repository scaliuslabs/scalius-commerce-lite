// Promotion authority introduced alongside the legacy discount-code tables.
// Checkout cutover is intentionally separate: these rows are not buyer-visible
// until the production evaluator and synchronous order commit share this model.

import { sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { orderItems, orders } from "./orders";
import { UNIX_NOW } from "./shared";

export const PROMOTION_METHODS = ["automatic", "code"] as const;
export const PROMOTION_STATUSES = ["draft", "active", "paused", "archived"] as const;
export const PROMOTION_CONDITION_KINDS = [
    "minimum_merchandise_subtotal",
    "minimum_item_quantity",
] as const;
export const PROMOTION_EFFECT_KINDS = [
    "percentage_off",
    "fixed_amount_off",
    "free",
] as const;
export const PROMOTION_EFFECT_TARGETS = ["line", "order", "shipping"] as const;
export const PROMOTION_ALLOCATIONS = ["across", "once"] as const;

export const promotions = sqliteTable("promotions", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    title: text("title"),
    method: text("method", { enum: PROMOTION_METHODS }).notNull(),
    status: text("status", { enum: PROMOTION_STATUSES }).notNull().default("draft"),
    priority: integer("priority").notNull().default(100),
    conflictPolicy: text("conflict_policy", { enum: ["best"] }).notNull().default("best"),
    startsAt: integer("starts_at", { mode: "timestamp" }),
    endsAt: integer("ends_at", { mode: "timestamp" }),
    timezone: text("timezone").notNull().default("Asia/Dhaka"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
    deletedAt: integer("deleted_at", { mode: "timestamp" }),
}, (table) => [
    index("promotions_evaluation_idx").on(
        table.status,
        table.deletedAt,
        table.startsAt,
        table.endsAt,
        table.priority,
        table.id,
    ),
    check("promotions_method_valid", sql`${table.method} IN ('automatic', 'code')`),
    check("promotions_status_valid", sql`${table.status} IN ('draft', 'active', 'paused', 'archived')`),
    check("promotions_conflict_policy_valid", sql`${table.conflictPolicy} = 'best'`),
    check("promotions_name_length", sql`length(trim(${table.name})) BETWEEN 1 AND 160`),
    check("promotions_title_length", sql`${table.title} IS NULL OR length(trim(${table.title})) BETWEEN 1 AND 200`),
    check("promotions_priority_range", sql`${table.priority} BETWEEN 0 AND 10000`),
    check("promotions_revision_positive", sql`${table.revision} >= 1`),
    check("promotions_timezone_length", sql`length(trim(${table.timezone})) BETWEEN 1 AND 80`),
    check("promotions_schedule_valid", sql`${table.endsAt} IS NULL OR ${table.startsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`),
]);

export const promotionCodes = sqliteTable("promotion_codes", {
    id: text("id").primaryKey(),
    promotionId: text("promotion_id")
        .notNull()
        .references(() => promotions.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    normalizedCode: text("normalized_code").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("promotion_codes_identity_unique").on(table.normalizedCode),
    index("promotion_codes_promotion_active_idx").on(table.promotionId, table.isActive),
    check(
        "promotion_codes_identity_valid",
        sql`${table.code} = trim(${table.code})
            AND ${table.normalizedCode} = upper(trim(${table.code}))
            AND length(${table.normalizedCode}) BETWEEN 3 AND 50
            AND ${table.normalizedCode} NOT GLOB '*[^A-Z0-9_-]*'`,
    ),
]);

export const promotionConditions = sqliteTable("promotion_conditions", {
    id: text("id").primaryKey(),
    promotionId: text("promotion_id")
        .notNull()
        .references(() => promotions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: PROMOTION_CONDITION_KINDS }).notNull(),
    config: text("config").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("promotion_conditions_position_unique").on(table.promotionId, table.position),
    index("promotion_conditions_promotion_idx").on(table.promotionId, table.kind),
    check(
        "promotion_conditions_kind_valid",
        sql`${table.kind} IN ('minimum_merchandise_subtotal', 'minimum_item_quantity')`,
    ),
    check("promotion_conditions_position_range", sql`${table.position} BETWEEN 0 AND 99`),
    check(
        "promotion_conditions_config_valid",
        sql`json_valid(${table.config}) AND json_type(${table.config}) = 'object' AND length(${table.config}) BETWEEN 2 AND 4000`,
    ),
    check(
        "promotion_conditions_config_shape",
        sql`coalesce((
            (${table.kind} = 'minimum_merchandise_subtotal'
                AND json_type(${table.config}, '$.amountMinor') = 'integer'
                AND json_extract(${table.config}, '$.amountMinor') BETWEEN 1 AND 9007199254740991
                AND json_type(${table.config}, '$.currencyCode') = 'text'
                AND length(json_extract(${table.config}, '$.currencyCode')) = 3
                AND json_extract(${table.config}, '$.currencyCode') = upper(json_extract(${table.config}, '$.currencyCode'))
                AND json_extract(${table.config}, '$.currencyCode') NOT GLOB '*[^A-Z]*')
            OR
            (${table.kind} = 'minimum_item_quantity'
                AND json_type(${table.config}, '$.quantity') = 'integer'
                AND json_extract(${table.config}, '$.quantity') BETWEEN 1 AND 1000000)
        ), 0)`,
    ),
]);

export const promotionEffects = sqliteTable("promotion_effects", {
    id: text("id").primaryKey(),
    promotionId: text("promotion_id")
        .notNull()
        .references(() => promotions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: PROMOTION_EFFECT_KINDS }).notNull(),
    target: text("target", { enum: PROMOTION_EFFECT_TARGETS }).notNull(),
    allocation: text("allocation", { enum: PROMOTION_ALLOCATIONS }).notNull(),
    config: text("config").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("promotion_effects_target_unique").on(table.promotionId, table.target),
    uniqueIndex("promotion_effects_position_unique").on(table.promotionId, table.position),
    index("promotion_effects_promotion_idx").on(table.promotionId, table.target),
    check(
        "promotion_effects_kind_valid",
        sql`${table.kind} IN ('percentage_off', 'fixed_amount_off', 'free')`,
    ),
    check("promotion_effects_target_valid", sql`${table.target} IN ('line', 'order', 'shipping')`),
    check("promotion_effects_allocation_valid", sql`${table.allocation} IN ('across', 'once')`),
    check("promotion_effects_position_range", sql`${table.position} BETWEEN 0 AND 99`),
    check(
        "promotion_effects_config_valid",
        sql`json_valid(${table.config}) AND json_type(${table.config}) = 'object' AND length(${table.config}) BETWEEN 2 AND 4000`,
    ),
    check(
        "promotion_effects_config_shape",
        sql`coalesce((
            (${table.kind} = 'percentage_off'
                AND json_type(${table.config}, '$.basisPoints') = 'integer'
                AND json_extract(${table.config}, '$.basisPoints') BETWEEN 1 AND 10000)
            OR
            (${table.kind} = 'fixed_amount_off'
                AND json_type(${table.config}, '$.amountMinor') = 'integer'
                AND json_extract(${table.config}, '$.amountMinor') BETWEEN 1 AND 9007199254740991
                AND json_type(${table.config}, '$.currencyCode') = 'text'
                AND length(json_extract(${table.config}, '$.currencyCode')) = 3
                AND json_extract(${table.config}, '$.currencyCode') = upper(json_extract(${table.config}, '$.currencyCode'))
                AND json_extract(${table.config}, '$.currencyCode') NOT GLOB '*[^A-Z]*')
            OR
            (${table.kind} = 'free' AND json(${table.config}) = '{}')
        ), 0)`,
    ),
    check(
        "promotion_effects_allocation_shape",
        sql`(
            (${table.target} = 'line' AND ${table.allocation} = 'across')
            OR
            (${table.target} IN ('order', 'shipping') AND ${table.allocation} = 'once')
        )`,
    ),
    check(
        "promotion_effects_free_shape",
        sql`${table.kind} <> 'free' OR ${table.target} = 'shipping'`,
    ),
]);

/**
 * Immutable order-time allocation facts. Refunds and reporting consume these
 * rows instead of re-evaluating mutable promotion rules.
 */
export const orderDiscountAllocations = sqliteTable("order_discount_allocations", {
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: text("order_item_id")
        .references(() => orderItems.id, { onDelete: "restrict" }),
    promotionId: text("promotion_id")
        .notNull()
        .references(() => promotions.id, { onDelete: "restrict" }),
    effectId: text("effect_id")
        .notNull()
        .references(() => promotionEffects.id, { onDelete: "restrict" }),
    promotionRevision: integer("promotion_revision").notNull(),
    evaluatorVersion: integer("evaluator_version").notNull(),
    method: text("method", { enum: PROMOTION_METHODS }).notNull(),
    promotionName: text("promotion_name").notNull(),
    promotionCode: text("promotion_code"),
    effectKind: text("effect_kind", { enum: PROMOTION_EFFECT_KINDS }).notNull(),
    target: text("target", { enum: PROMOTION_EFFECT_TARGETS }).notNull(),
    currencyCode: text("currency_code").notNull(),
    baseAmountMinor: integer("base_amount_minor").notNull(),
    discountAmountMinor: integer("discount_amount_minor").notNull(),
    quantity: integer("quantity"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("order_discount_allocations_merchandise_unique")
        .on(table.orderId, table.effectId, table.orderItemId)
        .where(sql`${table.target} IN ('line', 'order')`),
    uniqueIndex("order_discount_allocations_shipping_unique")
        .on(table.orderId, table.effectId, table.target)
        .where(sql`${table.target} = 'shipping'`),
    index("order_discount_allocations_order_idx").on(table.orderId, table.target, table.id),
    index("order_discount_allocations_promotion_idx").on(table.promotionId, table.createdAt),
    check("order_discount_allocations_method_valid", sql`${table.method} IN ('automatic', 'code')`),
    check(
        "order_discount_allocations_effect_kind_valid",
        sql`${table.effectKind} IN ('percentage_off', 'fixed_amount_off', 'free')`,
    ),
    check(
        "order_discount_allocations_target_valid",
        sql`${table.target} IN ('line', 'order', 'shipping')`,
    ),
    check("order_discount_allocations_promotion_revision_positive", sql`${table.promotionRevision} >= 1`),
    check("order_discount_allocations_evaluator_version_positive", sql`${table.evaluatorVersion} >= 1`),
    check("order_discount_allocations_name_length", sql`length(trim(${table.promotionName})) BETWEEN 1 AND 160`),
    check(
        "order_discount_allocations_code_shape",
        sql`(
            (${table.method} = 'automatic' AND ${table.promotionCode} IS NULL)
            OR
            (${table.method} = 'code'
                AND ${table.promotionCode} IS NOT NULL
                AND length(${table.promotionCode}) BETWEEN 3 AND 50
                AND ${table.promotionCode} = upper(trim(${table.promotionCode})))
        )`,
    ),
    check(
        "order_discount_allocations_target_shape",
        sql`(
            (${table.target} IN ('line', 'order')
                AND ${table.orderItemId} IS NOT NULL
                AND ${table.quantity} IS NOT NULL
                AND ${table.quantity} > 0)
            OR
            (${table.target} = 'shipping' AND ${table.orderItemId} IS NULL AND ${table.quantity} IS NULL)
        )`,
    ),
    check(
        "order_discount_allocations_currency_shape",
        sql`length(${table.currencyCode}) = 3
            AND ${table.currencyCode} = upper(${table.currencyCode})
            AND ${table.currencyCode} NOT GLOB '*[^A-Z]*'`,
    ),
    check(
        "order_discount_allocations_amount_shape",
        sql`${table.baseAmountMinor} > 0
            AND ${table.discountAmountMinor} > 0
            AND ${table.discountAmountMinor} <= ${table.baseAmountMinor}`,
    ),
]);

export type Promotion = InferSelectModel<typeof promotions>;
export type PromotionCode = InferSelectModel<typeof promotionCodes>;
export type PromotionCondition = InferSelectModel<typeof promotionConditions>;
export type PromotionEffect = InferSelectModel<typeof promotionEffects>;
export type OrderDiscountAllocation = InferSelectModel<typeof orderDiscountAllocations>;
