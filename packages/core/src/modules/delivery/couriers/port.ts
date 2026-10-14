// The courier as delivery code sees it: the shared courier port
// (`@scalius/shared/plugins/providers/courier`, the port app couriers
// implement) plus how a saved delivery provider row configures it. Booking,
// tracking, connection tests, recovery lookups and readiness are written once
// in delivery.service.ts and never branch on a courier id.
//
// Every courier is an app's: a merchant uses one through a
// `delivery_providers` row whose `type` is `<plugin id>:<provider id>`
// (`scalius.bangladesh:pathao`). Its credentials live in the app's own
// settings; the row carries none.
//
// Port failures are the port's `ProviderError`: a certain refusal (declined,
// misconfigured, or retryable without `uncertain`) means the courier booked
// nothing; `uncertain` means it may have, and the booking is kept for
// reconciliation, never submitted again.

import type { Database } from "@scalius/database/client";
import type { DeliveryProviderRecord } from "@scalius/database/schema";
import type { CourierShipmentInput, ProviderCountries, ProviderPort } from "@scalius/shared/plugins/providers";
import type { DeliveryProviderReadinessSummary } from "../provider-readiness";

/** The saved delivery provider row a courier reads its setup from. */
export type CourierRow = Pick<
  DeliveryProviderRecord,
  | "id"
  | "type"
  | "isActive"
  | "credentials"
  | "config"
  | "lastTestAttemptAt"
  | "lastTestSuccessAt"
  | "lastTestFailureAt"
  | "lastTestSuccessFingerprint"
>;

/** What every port call of a courier gets besides its input. */
export interface CourierCall<S = unknown> {
  /** The row's settings, read with `setup` for this request. */
  settings: S;
  signal: AbortSignal;
  /** The store's database, for the platform's own reads around a call (a courier's location ids). */
  db: Database;
}

/** A delivery provider row as one courier reads it. */
export interface CourierSetup<S = unknown> {
  /** What every call for this row gets; null when the saved setup cannot be read (never call the courier then). */
  settings: S | null;
  /** Why `settings` is null; merchant-safe, never a value. */
  error?: string;
  /** The saved secrets cannot be opened (a missing or rotated key): fail closed with `error`. */
  unreadable?: boolean;
  /** Setup, activation and connection-test readiness, as settings and shipment actions check it. */
  readiness: DeliveryProviderReadinessSummary;
}

export interface Courier<S = unknown> extends ProviderPort<"courier", CourierCall<S>> {
  /** `<plugin id>:<provider id>`. */
  readonly id: string;
  /** Merchant-facing courier name. */
  readonly label: string;
  /**
   * The countries it delivers to (MARKETS-DESIGN step 3a). It is never
   * offered for an order shipping elsewhere, and a booking for one is refused
   * before anything is written.
   */
  readonly countries: ProviderCountries;
  /** Reads a row's setup: strictly, failing closed on unreadable or placeholder credentials. */
  setup(provider: CourierRow, encryptionKey: string | undefined): Promise<CourierSetup<S>>;
  /**
   * The address levels a booking needs mapped to the courier's own ids
   * (Pathao: city and zone): the order page asks for them before booking.
   */
  readonly requiredLocations?: readonly ("city" | "zone" | "area")[];
  /**
   * Store setup a booking to this recipient needs before anything is written
   * (the courier's location ids on the store's places): a merchant-facing
   * reason it cannot be booked, or null.
   */
  preflight?(recipient: CourierShipmentInput["recipient"], db: Database): Promise<string | null>;
  /**
   * The courier's public tracking page for a parcel, kept with the shipment
   * when it is booked (the app's declared `trackingUrl`).
   */
  trackingUrl?(trackingId: string): string;
}
