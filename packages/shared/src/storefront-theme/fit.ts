// Data fit: a small summary of the store (StoreShape) and the conditions a
// block variant or section declares over it. Conditions are data, not
// functions, so the resolver, the dashboard ("why is this unavailable") and
// the tests all read the same rule (SYNTHESIS.md sections 5 and 6).
import { z } from "zod";

/** Counts are read with a LIMIT: anything at or above the cap reads as the cap. */
export const STORE_SHAPE_COUNT_CAP = 1000;

const count = z.number().int().min(0).max(STORE_SHAPE_COUNT_CAP);

/**
 * What the store holds, as far as layout choices care. The API computes it
 * with bounded reads (`@scalius/core` storefront service) and serves it
 * beside the theme, so the storefront and the dashboard resolve the same
 * document against the same facts.
 */
export const storeShapeSchema = z.object({
  /** Active, listed products. */
  productCount: count,
  /** Sellable SKUs (product variants) of those products. */
  skuCount: count,
  /** Published top-level categories. */
  topCategoryCount: count,
  /** Levels in the category tree (0 without categories; categories are flat today). */
  categoryDepth: z.number().int().min(0).max(4),
  /** Header menu (Online store -> Navigation): top-level items... */
  menuTopItems: count,
  /** ...its levels (0 without a menu)... */
  menuDepth: z.number().int().min(0).max(3),
  /** ...and mega-panel groups: the most second-level items with two or more links under one top item. */
  menuGroups: count,
  brandCount: count,
  hasCollections: z.boolean(),
  hasDeliveryMethods: z.boolean(),
  /** Typed spec attributes flagged as key specs (spec cards, spec tables). */
  hasKeySpecs: z.boolean(),
  hasEmiPlans: z.boolean(),
  hasDigitalLines: z.boolean(),
  hasReviews: z.boolean(),
  hasQuestions: z.boolean(),
  hasContentBlocks: z.boolean(),
}).strict();

export type StoreShape = z.infer<typeof storeShapeSchema>;

/** A store with nothing in it yet. */
export const EMPTY_STORE_SHAPE: StoreShape = Object.freeze({
  productCount: 0,
  skuCount: 0,
  topCategoryCount: 0,
  categoryDepth: 0,
  menuTopItems: 0,
  menuDepth: 0,
  menuGroups: 0,
  brandCount: 0,
  hasCollections: false,
  hasDeliveryMethods: false,
  hasKeySpecs: false,
  hasEmiPlans: false,
  hasDigitalLines: false,
  hasReviews: false,
  hasQuestions: false,
  hasContentBlocks: false,
});

type KeysOfType<T, V> = { [K in keyof T]: T[K] extends V ? K : never }[keyof T];
export type StoreShapeCountFact = KeysOfType<StoreShape, number>;
export type StoreShapeFlagFact = KeysOfType<StoreShape, boolean>;

export type FitCondition =
  | { readonly fact: StoreShapeCountFact; readonly min?: number; readonly max?: number }
  | { readonly fact: StoreShapeFlagFact; readonly equals: boolean }
  | { readonly anyOf: readonly FitCondition[] }
  /** Another block of the same document resolved to one of these variants. */
  | { readonly block: string; readonly variants: readonly string[] };

export const atLeast = (fact: StoreShapeCountFact, min: number): FitCondition => ({ fact, min });
export const atMost = (fact: StoreShapeCountFact, max: number): FitCondition => ({ fact, max });
export const between = (fact: StoreShapeCountFact, min: number, max: number): FitCondition => ({ fact, min, max });
export const has = (fact: StoreShapeFlagFact): FitCondition => ({ fact, equals: true });
export const anyOf = (...conditions: FitCondition[]): FitCondition => ({ anyOf: conditions });
export const blockIs = (block: string, ...variants: string[]): FitCondition => ({ block, variants });

export interface FitContext {
  shape: StoreShape;
  /** Variant ids of the blocks resolved so far, by slot. */
  blocks: Readonly<Record<string, string>>;
}

function conditionHolds(condition: FitCondition, context: FitContext): boolean {
  if ("anyOf" in condition) return condition.anyOf.some((each) => conditionHolds(each, context));
  if ("block" in condition) {
    const variant = context.blocks[condition.block];
    return variant !== undefined && condition.variants.includes(variant);
  }
  if ("equals" in condition) return context.shape[condition.fact] === condition.equals;
  const value = context.shape[condition.fact];
  return (condition.min === undefined || value >= condition.min)
    && (condition.max === undefined || value <= condition.max);
}

/** The conditions that fail (empty when everything fits). */
export function failedFitConditions(
  requires: readonly FitCondition[],
  context: FitContext,
): FitCondition[] {
  return requires.filter((condition) => !conditionHolds(condition, context));
}

/** A menu tree as the storefront's navigation payload carries it. */
export interface StoreShapeMenuItem {
  subMenu?: readonly StoreShapeMenuItem[] | null;
}

function menuDepth(items: readonly StoreShapeMenuItem[]): number {
  if (items.length === 0) return 0;
  return 1 + Math.max(...items.map((item) => menuDepth(item.subMenu ?? [])));
}

const capped = (value: number) => Math.min(Math.max(0, Math.floor(value)), STORE_SHAPE_COUNT_CAP);

/** The store shape from counted facts and the header menu tree. */
export function storeShapeFromFacts(facts: {
  productCount: number;
  skuCount: number;
  topCategoryCount: number;
  categoryDepth: number;
  menu: readonly StoreShapeMenuItem[];
  brandCount?: number;
  hasCollections: boolean;
  hasDeliveryMethods: boolean;
  hasKeySpecs?: boolean;
  hasEmiPlans?: boolean;
  hasDigitalLines?: boolean;
  hasReviews?: boolean;
  hasQuestions?: boolean;
  hasContentBlocks?: boolean;
}): StoreShape {
  const groups = facts.menu.map((item) =>
    (item.subMenu ?? []).filter((child) => (child.subMenu?.length ?? 0) >= 2).length);
  return storeShapeSchema.parse({
    productCount: capped(facts.productCount),
    skuCount: capped(facts.skuCount),
    topCategoryCount: capped(facts.topCategoryCount),
    categoryDepth: Math.min(4, Math.max(0, facts.categoryDepth)),
    menuTopItems: capped(facts.menu.length),
    menuDepth: Math.min(3, menuDepth(facts.menu)),
    menuGroups: capped(Math.max(0, ...groups)),
    brandCount: capped(facts.brandCount ?? 0),
    hasCollections: facts.hasCollections,
    hasDeliveryMethods: facts.hasDeliveryMethods,
    hasKeySpecs: facts.hasKeySpecs ?? false,
    hasEmiPlans: facts.hasEmiPlans ?? false,
    hasDigitalLines: facts.hasDigitalLines ?? false,
    hasReviews: facts.hasReviews ?? false,
    hasQuestions: facts.hasQuestions ?? false,
    hasContentBlocks: facts.hasContentBlocks ?? false,
  });
}
