import type { CourierBookingOptionValue } from "@scalius/shared/plugins/providers";

export const PROVIDER_OUTCOME_UNKNOWN = "provider_outcome_unknown";

// Common interfaces
export interface ShipmentResult {
  success: boolean;
  message: string;
  shipmentId?: string;
  reconciliationRequired?: boolean;
  data?: {
    externalId?: string;
    trackingId?: string;
    status?: string;
    metadata?: Record<string, unknown>;
  };
}

export type MerchantOrderShipmentLookup =
  | {
    confirmed: true;
    /** The courier that confirmed the booking, merchant-facing. */
    courier: string;
    /** The booking id, when the courier's lookup returns it. */
    externalId: string | null;
    status: string;
    rawStatus: string;
  }
  | {
    confirmed: false;
    message: string;
    /**
     * Why: the courier answered that it has no booking (`not_found`), it has
     * no lookup by order number (`unsupported`), or the lookup could not run
     * or its courier app is not loaded (`unavailable`, which proves nothing).
     */
    reason: "not_found" | "unsupported" | "unavailable";
  };

/**
 * Staff choices on the booking form. Money, item count and contents always
 * come from the saved order, never from the caller. `bookingOptions` are the
 * courier's own, by the keys it declares (`bookingOptions` in its manifest
 * entry); `itemWeight` (kg) is the parcel weight.
 */
export interface ShipmentOptions {
  bookingOptions?: Readonly<Record<string, CourierBookingOptionValue>>;
  itemWeight?: number;
  note?: string;
}
