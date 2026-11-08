// Test-only (never import from Worker code): the checkout fence of a
// hand-built commit payload, read synchronously from a migrated SQLite store.
import type { DatabaseSync } from "node:sqlite";

import { checkoutFenceScopes } from "../modules/checkout/authority";

/** The fence a checkout of these products commits under now (`checkoutFence` of a payload). */
export function sqliteCheckoutFence(sqlite: DatabaseSync, productIds: readonly string[]): { scopes: string[]; revision: number } {
    const scopes = checkoutFenceScopes(productIds);
    const row = sqlite.prepare(
        "SELECT coalesce(sum(revision), 0) AS revision FROM checkout_fences WHERE scope IN (SELECT value FROM json_each(?))",
    ).get(JSON.stringify(scopes)) as { revision: number } | undefined;
    return { scopes, revision: Number(row?.revision ?? 0) };
}

/** One fence scope's revision (0: it never changed). */
export function sqliteCheckoutFenceRevision(sqlite: DatabaseSync, scope: string): number {
    const row = sqlite.prepare("SELECT revision FROM checkout_fences WHERE scope = ?").get(scope) as { revision: number } | undefined;
    return Number(row?.revision ?? 0);
}
