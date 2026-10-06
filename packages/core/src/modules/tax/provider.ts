// The tax provider port as checkout calls it (MARKETS-DESIGN D8). The
// built-in system provider and app tax providers implement the same port
// (`@scalius/shared/plugins/providers`, "tax"); checkout resolves one per
// order and never asks which kind it got.
//
// Selection, the one rule: the address's country region names a provider,
// else the store-wide one (Settings → Taxes) decides; an address with no
// region of its country pays no tax and no provider is asked. `system` is
// bound to the store's tax authority with no read; an app id is resolved
// through the request's `AppProviders`, so a store on the system provider
// reads no plugin table. Fail closed: when the chosen app cannot run or
// cannot answer, checkout refuses (`tax_unavailable`) rather than charging
// no tax.
import {
    bindProvider,
    resolveAppProvider,
    type AppProviders,
    type BoundProvider,
    type BuiltInAdapter,
} from "../../integrations/provider-port";
import {
    calculateSystemTax,
    completeTaxQuote,
    prepareTaxQuote,
    systemTaxSettingsOf,
    taxUnavailable,
    type SystemTaxSettings,
} from "./calculator";
import { SYSTEM_TAX_PROVIDER_ID, type CalculateTaxQuoteInput, type TaxQuote } from "./types";

/**
 * The built-in provider. It keeps no documents: `commit`, `void` and
 * `refund` are idempotent no-ops (Medusa's system provider), answering a
 * stable document id.
 */
export const SYSTEM_TAX_PROVIDER: BuiltInAdapter<"tax", SystemTaxSettings> = {
    id: SYSTEM_TAX_PROVIDER_ID,
    label: "Scalius tax rates",
    async calculate(input, { settings }) {
        return calculateSystemTax(input, settings);
    },
    async commit(input) {
        return { documentId: `${SYSTEM_TAX_PROVIDER_ID}:${input.orderId}` };
    },
    async void(input) {
        return { documentId: `${SYSTEM_TAX_PROVIDER_ID}:${input.orderId}` };
    },
    async refund(input) {
        return { documentId: `${SYSTEM_TAX_PROVIDER_ID}:${input.orderId}:${input.refundId}` };
    },
};

/** The provider `providerId` names, ready to call, or why it cannot be used now (merchant-facing). */
export async function resolveTaxProvider(
    providerId: string,
    settings: SystemTaxSettings,
    apps: AppProviders | undefined,
): Promise<{ provider: BoundProvider<"tax">; issue: null } | { provider: null; issue: string }> {
    if (providerId === SYSTEM_TAX_PROVIDER_ID) {
        return { provider: bindProvider("tax", SYSTEM_TAX_PROVIDER, settings), issue: null };
    }
    return resolveAppProvider(apps, "tax", providerId);
}

export interface QuoteTaxOptions {
    /** The request's app providers; without them an app provider fails closed. */
    apps?: AppProviders;
    signal?: AbortSignal;
}

/**
 * The tax quote through the selected provider. The system provider answers
 * in process; an app is called once per priced cart (its idempotency key)
 * and any failure refuses checkout.
 */
export async function quoteTax(input: CalculateTaxQuoteInput, options: QuoteTaxOptions = {}): Promise<TaxQuote> {
    const prepared = prepareTaxQuote(input);
    if (prepared.providerId === null || prepared.request === null) return completeTaxQuote(prepared, null);
    const chosen = await resolveTaxProvider(prepared.providerId, systemTaxSettingsOf(input), options.apps);
    if (!chosen.provider) throw taxUnavailable(chosen.issue);
    // Nothing taxable to ask an app about (every line exempt, shipping untaxed).
    if (prepared.providerId !== SYSTEM_TAX_PROVIDER_ID && prepared.request.lines.length === 0 && prepared.request.shippingTaxCode === undefined) {
        return completeTaxQuote(prepared, null);
    }
    if (prepared.providerId === SYSTEM_TAX_PROVIDER_ID) {
        return completeTaxQuote(prepared, await chosen.provider.calculate(prepared.request, { signal: options.signal }));
    }
    let calculation;
    try {
        calculation = await chosen.provider.calculate(prepared.request, { signal: options.signal });
    } catch {
        // Whatever the app raised (a ProviderError, a timeout, an invalid
        // answer), the buyer sees one refusal; its own words stay with it.
        throw taxUnavailable();
    }
    return completeTaxQuote(prepared, calculation);
}

/**
 * After an order commits: an app provider's calculation becomes its
 * committed document (idempotent per order). The order never waits on it or
 * fails with it; the system provider keeps no document. Null: nothing to
 * commit, or the app could not (it keeps the calculation id on the order's
 * tax snapshot for a later reconciliation).
 */
export async function commitTaxDocument(
    quote: Pick<TaxQuote, "jurisdiction">,
    orderId: string,
    apps: AppProviders | undefined,
): Promise<{ documentId: string } | null> {
    const { providerId, calculationId } = quote.jurisdiction ?? {};
    if (!providerId || providerId === SYSTEM_TAX_PROVIDER_ID || !calculationId) return null;
    const choice = await resolveAppProvider(apps, "tax", providerId);
    if (!choice.provider?.commit) return null;
    try {
        return await choice.provider.commit({ calculationId, orderId, idempotencyKey: `tax-commit:${orderId}` }, {});
    } catch {
        console.warn("[tax] provider commit failed", { provider: providerId, order: orderId.slice(0, 12) });
        return null;
    }
}
