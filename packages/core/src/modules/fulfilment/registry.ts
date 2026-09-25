// The fulfiller registry (Wave A §2.6): which order-line types this store can
// hand over, and how. `ship`, `pickup` and `service` are manual (staff act);
// `digital` and `gift_card` are automatic once payment settles, and have no
// fulfiller until Wave B registers one. A line whose type has no fulfiller
// fails closed at cart validation and commit (FULFILMENT_UNAVAILABLE).
//
// The registry is a frozen constant: no request state, no mutation at runtime.
import type { Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import {
    FULFILLMENT_TYPES,
    type FulfillmentType,
} from "@scalius/shared/fulfilment";
import { digitalFulfiller } from "./auto/digital";
import { giftCardFulfiller } from "./auto/gift-card";

export interface AutoFulfilLine {
    orderItemId: string;
    productId: string;
    variantId: string | null;
    /** Units not handed over yet. */
    quantity: number;
}

export interface AutoFulfilContext {
    orderId: string;
    fulfillmentId: string;
    lines: readonly AutoFulfilLine[];
}

/**
 * An automatic fulfiller (Wave B: digital downloads, gift-card issue). It
 * returns the statements that deliver the lines; they run in the same batch
 * as the ledger insert, so a delivery and its ledger row commit together.
 */
export interface AutoFulfiller {
    prepare(db: Database, context: AutoFulfilContext): Promise<BatchItem<"sqlite">[]>;
}

export type FulfillerEntry =
    | { mode: "manual" }
    | { mode: "auto"; fulfiller: AutoFulfiller };

export type FulfillerRegistry = Readonly<Record<FulfillmentType, FulfillerEntry | null>>;

function autoEntry(fulfiller: AutoFulfiller | null): FulfillerEntry | null {
    return fulfiller ? { mode: "auto", fulfiller } : null;
}

/**
 * The manual types, and the automatic ones composed from `auto/*` (each file
 * is filled by the slice that owns its domain). A missing automatic fulfiller
 * stays `null`: those lines fail closed.
 */
export const FULFILLER_REGISTRY: FulfillerRegistry = Object.freeze({
    ship: { mode: "manual" },
    pickup: { mode: "manual" },
    service: { mode: "manual" },
    digital: autoEntry(digitalFulfiller),
    gift_card: autoEntry(giftCardFulfiller),
});

export function hasFulfiller(
    type: FulfillmentType,
    registry: FulfillerRegistry = FULFILLER_REGISTRY,
): boolean {
    return registry[type] !== null;
}

/** The distinct types among `types` that nothing can fulfil, in registry order. */
export function unavailableFulfilmentTypes(
    types: readonly FulfillmentType[],
    registry: FulfillerRegistry = FULFILLER_REGISTRY,
): FulfillmentType[] {
    const present = new Set(types);
    return FULFILLMENT_TYPES.filter((type) => present.has(type) && !hasFulfiller(type, registry));
}

/** The automatic fulfiller for a type, when one is registered. */
export function autoFulfillerFor(
    type: FulfillmentType,
    registry: FulfillerRegistry = FULFILLER_REGISTRY,
): AutoFulfiller | null {
    const entry = registry[type];
    return entry?.mode === "auto" ? entry.fulfiller : null;
}
