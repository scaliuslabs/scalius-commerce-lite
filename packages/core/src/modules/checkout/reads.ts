// The reads a storefront checkout commit needs before it writes.
import { safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { selectReservationVariantStates, type ReservationVariantState } from "../inventory";
import {
    selectContactCustomerCandidates,
    type ContactCustomerCandidate,
    type OrderContact,
} from "../customers/customer-identity";
import {
    resolveCheckoutAttemptRow,
    selectCheckoutAttemptByKey,
    type CheckoutAttemptIdentity,
    type CheckoutAttemptRow,
    type ExistingCheckoutAttemptResult,
} from "./attempts";
import {
    createStorefrontCheckoutAuthorityReadPlan,
    type StorefrontCheckoutAuthorityInput,
    type StorefrontCheckoutAuthoritySnapshot,
} from "./authority";

export type SQLiteBatchItem = BatchItem<"sqlite">;

/**
 * Rows the commit would otherwise read one by one, fetched in the checkout's
 * single read batch. Everything stays re-guarded inside the commit batch.
 */
export interface StorefrontOrderCommitReads {
    contact: OrderContact;
    contactCustomers: ContactCustomerCandidate[];
    variantStates: ReservationVariantState[];
}

type SettledAuthority =
    | { ok: true; snapshot: StorefrontCheckoutAuthoritySnapshot }
    | { ok: false; error: unknown };

function tagCheckoutError(error: unknown, code: string): unknown {
    if (error instanceof Error && !("code" in error)) {
        Object.defineProperty(error, "code", { configurable: true, enumerable: false, value: code });
    }
    return error;
}

/**
 * One read round trip for a storefront checkout: the idempotency row, the
 * checkout authority snapshot, and the rows the commit needs. The attempt is
 * decided first so a committed request replays even if authority changed.
 */
export async function loadStorefrontCheckoutReads<TResponse>(
    db: Database,
    identity: CheckoutAttemptIdentity,
    authorityInput: StorefrontCheckoutAuthorityInput & { customerPhone: string; customerEmail?: string | null },
    credentialEncryptionKey?: string,
): Promise<{
    existingAttempt: ExistingCheckoutAttemptResult<TResponse> | null;
    commitReads: StorefrontOrderCommitReads;
    authority(): StorefrontCheckoutAuthoritySnapshot;
}> {
    const plan = createStorefrontCheckoutAuthorityReadPlan(db, authorityInput);
    const contact: OrderContact = { phone: authorityInput.customerPhone, email: authorityInput.customerEmail ?? null };
    const variantIds = [...new Set(authorityInput.items
        .map((item) => item.variantId)
        .filter((variantId): variantId is string => typeof variantId === "string" && variantId.length > 0))];
    const statements = [
        ...plan.statements,
        selectCheckoutAttemptByKey(db, identity.requestKey),
        selectContactCustomerCandidates(db, contact),
        selectReservationVariantStates(db, variantIds),
    ];
    let results: unknown[];
    try {
        results = await safeBatch(db, statements as SQLiteBatchItem[]) as unknown[];
    } catch (error) {
        throw tagCheckoutError(error, "CHECKOUT_AUTHORITY_BATCH");
    }
    const [attemptRows, customerRows, variantRows] = results.slice(plan.statements.length) as [
        CheckoutAttemptRow[],
        ContactCustomerCandidate[],
        ReservationVariantState[],
    ];
    const existingAttempt = resolveCheckoutAttemptRow<TResponse>(attemptRows[0], identity);
    const settled: SettledAuthority = existingAttempt?.status === "replay"
        ? { ok: false, error: new Error("Replayed checkout does not resolve authority.") }
        : await plan.resolve(results.slice(0, plan.statements.length), credentialEncryptionKey)
            .then((snapshot): SettledAuthority => ({ ok: true, snapshot }))
            .catch((error: unknown): SettledAuthority => ({
                ok: false,
                error: tagCheckoutError(error, "CHECKOUT_AUTHORITY_RESOLVE"),
            }));
    return {
        existingAttempt,
        commitReads: {
            contact,
            contactCustomers: customerRows,
            variantStates: variantRows,
        },
        authority() {
            if (!settled.ok) throw settled.error;
            return settled.snapshot;
        },
    };
}
