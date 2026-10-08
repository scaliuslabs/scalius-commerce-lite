// The reads a storefront checkout commit needs before it writes.
import { safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { selectReservationVariantStates, type ReservationVariantState } from "../inventory";
import {
  type ContactCustomerCandidate,
  type OrderContact,
  selectContactCustomerCandidates,
} from "../customers";
import {
    resolveCheckoutAttemptRow,
    selectCheckoutAttemptByKey,
    type CheckoutAttemptIdentity,
    type CheckoutAttemptRow,
    type ExistingCheckoutAttemptResult,
} from "./attempts";
import {
  type ActiveFunctionRegistrationRow,
  type RegisteredPlugin,
  resolveActiveFunctionRegistrations,
  selectActiveCheckoutRegistrations,
} from "../plugins";
import { BUILT_IN_PAYMENT_PROVIDERS, type PaymentProviders, resolveAppPaymentUsability } from "../payments";
import { NO_CHECKOUT_APP_FUNCTIONS, type CheckoutAppFunctions } from "./app-functions";
import type { AppLinePricer } from "./app-line-prices";
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
 * checkout authority snapshot, the rows the commit needs and the apps'
 * checkout function and payment provider registrations (none: checkout does
 * no app work). The attempt is decided first so a committed request replays
 * even if authority changed. `paymentProviders` turns the active payment
 * provider registrations into the request's gateways (the API builds them;
 * without it only built-in gateways are offered). `apps` builds the
 * request's checkout functions from the function registrations, and
 * `linePricer` the `cart.line_prices` pricer from them, before the cart
 * is priced.
 */
export async function loadStorefrontCheckoutReads<TResponse>(
    db: Database,
    identity: CheckoutAttemptIdentity,
    authorityInput: StorefrontCheckoutAuthorityInput & { customerPhone: string | null; customerEmail?: string | null },
    credentialEncryptionKey?: string,
    options: {
        paymentProviders?: (registrations: readonly RegisteredPlugin[]) => PaymentProviders;
        apps?: (registrations: RegisteredPlugin[]) => CheckoutAppFunctions;
        linePricer?: (apps: CheckoutAppFunctions) => AppLinePricer | undefined;
    } = {},
): Promise<{
    existingAttempt: ExistingCheckoutAttemptResult<TResponse> | null;
    commitReads: StorefrontOrderCommitReads;
    authority(): StorefrontCheckoutAuthoritySnapshot;
    /** Active checkout function registrations, every point. */
    functionRegistrations: RegisteredPlugin[];
    /** The request's gateways: built-in and the active app providers. */
    paymentProviders: PaymentProviders;
    /** The request's checkout functions (`options.apps`), or none. */
    apps: CheckoutAppFunctions;
}> {
    let linePricer: AppLinePricer | undefined;
    const plan = createStorefrontCheckoutAuthorityReadPlan(db, { ...authorityInput, linePricer: () => linePricer });
    const contact: OrderContact = { phone: authorityInput.customerPhone, email: authorityInput.customerEmail ?? null };
    const variantIds = [...new Set(authorityInput.items
        .map((item) => item.variantId)
        .filter((variantId): variantId is string => typeof variantId === "string" && variantId.length > 0))];
    const statements = [
        ...plan.statements,
        selectCheckoutAttemptByKey(db, identity.requestKey),
        selectContactCustomerCandidates(db, contact),
        selectReservationVariantStates(db, variantIds),
        selectActiveCheckoutRegistrations(db),
    ];
    let results: unknown[];
    try {
        results = await safeBatch(db, statements as SQLiteBatchItem[]) as unknown[];
    } catch (error) {
        throw tagCheckoutError(error, "CHECKOUT_AUTHORITY_BATCH");
    }
    const [attemptRows, customerRows, variantRows, registrationRows] = results.slice(plan.statements.length) as [
        CheckoutAttemptRow[],
        ContactCustomerCandidate[],
        ReservationVariantState[],
        ActiveFunctionRegistrationRow[] | undefined,
    ];
    const existingAttempt = resolveCheckoutAttemptRow<TResponse>(attemptRows[0], identity);
    const registrations = resolveActiveFunctionRegistrations(registrationRows ?? []);
    const paymentRegistrations = registrations.filter((registration) => registration.kind === "provider");
    const paymentProviders = paymentRegistrations.length > 0 && options.paymentProviders
        ? options.paymentProviders(paymentRegistrations)
        : BUILT_IN_PAYMENT_PROVIDERS;
    const functionRegistrations = registrations.filter((registration) => registration.kind !== "provider");
    const apps = options.apps?.(functionRegistrations) ?? NO_CHECKOUT_APP_FUNCTIONS;
    linePricer = options.linePricer?.(apps);
    const settled: SettledAuthority = existingAttempt?.status === "replay"
        ? { ok: false, error: new Error("Replayed checkout does not resolve authority.") }
        : await plan.resolve(
            results.slice(0, plan.statements.length),
            credentialEncryptionKey,
            await resolveAppPaymentUsability(db, paymentProviders.gateways, credentialEncryptionKey),
        )
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
        functionRegistrations,
        paymentProviders,
        apps,
    };
}
