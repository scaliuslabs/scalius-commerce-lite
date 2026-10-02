import type {
  MarketingChannel,
  MarketingConsentSource,
  MarketingConsentState,
  MarketingConsentStatus,
} from "@scalius/shared/customer-marketing";
import type { BadgeVariant } from "~/components/ui/badge";

/** Status → badge (DESIGN.md: the badge always carries the word). */
export const CONSENT_BADGE: Record<MarketingConsentStatus, BadgeVariant> = {
  subscribed: "success",
  pending: "attention",
  unsubscribed: "secondary",
  not_subscribed: "outline",
};

export interface ConsentView {
  channel: MarketingChannel;
  status: MarketingConsentStatus;
  state: MarketingConsentState | null;
  contact: string | null;
  source: MarketingConsentSource | null;
  subscribedAt: string | null;
  unsubscribedAt: string | null;
  requestedAt: string | null;
  updatedAt: string | null;
}

/**
 * The line under a channel's status: no address to send to, consent given
 * for an address the customer no longer has, or where it came from and when.
 */
export type ConsentFacts =
  | { kind: "no_contact" }
  | { kind: "other_address" }
  | { kind: "none" }
  | { kind: "dated"; source: MarketingConsentSource | null; at: string | null };

export function consentFacts(consent: ConsentView): ConsentFacts {
  if (!consent.contact) return { kind: "no_contact" };
  if (consent.status === "not_subscribed") return consent.state ? { kind: "other_address" } : { kind: "none" };
  const at = consent.status === "subscribed"
    ? consent.subscribedAt
    : consent.status === "pending" ? consent.requestedAt : consent.unsubscribedAt;
  return { kind: "dated", source: consent.source, at: at ?? consent.updatedAt };
}

/** The change a staff member most likely wants: unsubscribe a subscriber, subscribe anyone else. */
export function suggestedConsentChange(status: MarketingConsentStatus): "subscribed" | "unsubscribed" {
  return status === "subscribed" || status === "pending" ? "unsubscribed" : "subscribed";
}
