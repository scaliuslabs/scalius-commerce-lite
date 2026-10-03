// The courier as delivery code sees it: the shared courier port
// (`@scalius/shared/plugins/providers/courier`, the same port app couriers
// implement) plus how a saved delivery provider row configures it. A courier
// adapter speaks one courier's protocol; booking, tracking, connection tests,
// recovery lookups and readiness are written once in delivery.service.ts and
// never branch on a courier id, or on whether the courier is built in or an
// app's.
//
// A merchant uses a courier through a `delivery_providers` row whose `type`
// is the courier id: `pathao`, `steadfast`, or an app courier's
// `<plugin id>:<provider id>`. Built-in couriers keep their credentials on
// the row (encrypted with CREDENTIAL_ENCRYPTION_KEY); an app courier's live
// in the app's own settings and its row carries none.
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
  /** The store's database, for adapters that read store data (Pathao's location mappings). */
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
  /** The keyed fingerprint of the setup a live connection test proves; null when the courier keeps no test proof. */
  fingerprint: string | null;
}

export interface Courier<S = unknown> extends ProviderPort<"courier", CourierCall<S>> {
  /** `pathao`, `steadfast`, or an app courier's `<plugin id>:<provider id>`. */
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
   * Store setup a booking to this recipient needs before anything is written
   * (Pathao's location mappings): a merchant-facing reason it cannot be
   * booked, or null.
   */
  preflight?(recipient: CourierShipmentInput["recipient"], db: Database): Promise<string | null>;
  /**
   * The courier's public tracking page for a parcel, kept with the shipment
   * when it is booked (an app's declared `trackingUrl`). Built-in couriers'
   * pages are derived where they are shown (`getTrackingUrl`).
   */
  trackingUrl?(trackingId: string): string;
}
