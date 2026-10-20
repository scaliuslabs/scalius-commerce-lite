// Who may pay later (`@scalius/shared/payment-terms`): the deferred methods a
// buyer's checkout may offer and the terms an order placed with one keeps.
//
// - A guest is never offered a deferred method.
// - The built-in invoice (`net_terms`) reaches a signed-in customer with one
//   of the merchant's tags or in one of the merchant's segments. With "apps
//   decide", an app's `checkout.payment_methods` answer may also allow it
//   (`{ op: "allow" }`): the method is then `gated` until one does, so an app
//   that fails or does not answer leaves it hidden (fail closed).
// - An app's deferred method (`flow: "deferred"`) is `gated` for every
//   signed-in buyer: it is offered only when its own app's
//   `checkout.payment_methods` allows it for this buyer. An app that fails,
//   times out or does not answer leaves it hidden (fail closed), so nobody
//   buys on credit because an app was slow.
//
// Reads happen only when a deferred method is enabled and the buyer is
// signed in: one statement for the tags, one for the segment definitions
// and one batch for their membership. No other checkout reads anything more.
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { customerTagLinks } from "@scalius/database/schema";
import {
  NET_TERMS_PAYMENT_METHOD,
  type NetTermsSettings,
} from "@scalius/shared/payment-terms";
import { ValidationError } from "../../errors";
import { PAYMENT_METHOD_UNAVAILABLE_REASON } from "./app-functions";
import { customerSegmentMembership, readSegmentDefinitions } from "../customers";
import type { PaymentProviders } from "../payments";

export const PAYMENT_TERMS_UNAVAILABLE_MESSAGE = "Paying later by invoice isn't available for this order. Choose another payment method.";
export const PAYMENT_TERMS_SIGN_IN_MESSAGE = "Sign in to pay later by invoice.";

/** The deferred methods one buyer may see, and those an app must still allow. */
export interface DeferredPaymentEligibility {
  /** Deferred methods this buyer may use now. */
  eligible: ReadonlySet<string>;
  /** Deferred methods offered only if an app's `checkout.payment_methods` allows them. */
  gated: ReadonlySet<string>;
}

export const NO_DEFERRED_ELIGIBILITY: DeferredPaymentEligibility = { eligible: new Set(), gated: new Set() };

/** Whether the buyer has one of the tags (tags are stored lowercase). */
async function hasAnyTag(db: Database, customerId: string, tags: readonly string[]): Promise<boolean> {
  if (tags.length === 0) return false;
  const row = await db.select({ tag: customerTagLinks.tag }).from(customerTagLinks)
    .where(and(eq(customerTagLinks.customerId, customerId), inArray(customerTagLinks.tag, tags.map((tag) => tag.toLowerCase()))))
    .limit(1)
    .get();
  return Boolean(row);
}

async function inAnySegment(db: Database, customerId: string, segmentIds: readonly string[]): Promise<boolean> {
  if (segmentIds.length === 0) return false;
  const definitions = await readSegmentDefinitions(db, segmentIds);
  const members = await customerSegmentMembership(
    db,
    customerId,
    segmentIds.map((id) => ({ id, definition: definitions.get(id) ?? null })),
  );
  return members.size > 0;
}

/** Whether the merchant's invoice settings name this signed-in customer (tags, then segments). */
export async function customerHasNetTerms(
  db: Database,
  customerId: string,
  settings: Pick<NetTermsSettings, "customerTags" | "segmentIds">,
): Promise<boolean> {
  if (await hasAnyTag(db, customerId, settings.customerTags)) return true;
  return inAnySegment(db, customerId, settings.segmentIds);
}

/**
 * The deferred methods among `enabledMethods` the buyer may use. A guest
 * (no account customer) gets none and causes no read.
 */
export async function resolveDeferredPaymentEligibility(
  db: Database,
  input: {
    enabledMethods: readonly string[];
    netTerms: NetTermsSettings;
    /** The signed-in account's customer id; null for a guest. */
    customerId: string | null | undefined;
    providers: Pick<PaymentProviders, "isDeferred">;
  },
): Promise<DeferredPaymentEligibility> {
  const deferred = input.enabledMethods.filter((method) => input.providers.isDeferred(method));
  if (deferred.length === 0 || !input.customerId) return NO_DEFERRED_ELIGIBILITY;
  const eligible = new Set<string>();
  const gated = new Set<string>();
  for (const method of deferred) {
    if (method !== NET_TERMS_PAYMENT_METHOD) {
      gated.add(method);
      continue;
    }
    if (await customerHasNetTerms(db, input.customerId, input.netTerms)) eligible.add(method);
    else if (input.netTerms.appsDecide) gated.add(method);
  }
  return { eligible, gated };
}

/** The methods a buyer's checkout may list (eligible, plus those an app may still allow). */
export function offeredDeferredMethods(eligibility: DeferredPaymentEligibility): ReadonlySet<string> {
  return new Set([...eligibility.eligible, ...eligibility.gated]);
}

/**
 * Placement with a deferred method: refused for a guest and for a buyer the
 * method does not reach; otherwise its terms, and whether an app must still
 * allow it (`gated`, checked with the apps' answer). Null when the method is
 * not deferred.
 */
export async function resolveOrderDeferredTerms(
  db: Database,
  input: {
    method: string;
    customerId: string | null | undefined;
    payment: { enabledMethods: readonly string[]; netTerms: NetTermsSettings };
    providers: Pick<PaymentProviders, "isDeferred" | "declaredTermsDays">;
  },
): Promise<{ days: number; eligibility: DeferredPaymentEligibility } | null> {
  if (!input.providers.isDeferred(input.method)) return null;
  if (!input.customerId) {
    throw new ValidationError(PAYMENT_TERMS_SIGN_IN_MESSAGE, { reason: PAYMENT_METHOD_UNAVAILABLE_REASON });
  }
  const eligibility = await resolveDeferredPaymentEligibility(db, {
    enabledMethods: input.payment.enabledMethods,
    netTerms: input.payment.netTerms,
    customerId: input.customerId,
    providers: input.providers,
  });
  if (!eligibility.eligible.has(input.method) && !eligibility.gated.has(input.method)) {
    throw new ValidationError(PAYMENT_TERMS_UNAVAILABLE_MESSAGE, { reason: PAYMENT_METHOD_UNAVAILABLE_REASON });
  }
  return { days: deferredTermsDays(input.method, input.payment.netTerms, input.providers), eligibility };
}

/**
 * The terms (days) of an order placed with a deferred method: the merchant's
 * net days for the invoice, the app's declared days for an app method.
 */
export function deferredTermsDays(
  method: string,
  netTerms: Pick<NetTermsSettings, "dueInDays">,
  providers: Pick<PaymentProviders, "declaredTermsDays">,
): number {
  if (method === NET_TERMS_PAYMENT_METHOD) return netTerms.dueInDays;
  const days = providers.declaredTermsDays(method);
  if (days === null) throw new ValidationError(PAYMENT_TERMS_UNAVAILABLE_MESSAGE);
  return days;
}
