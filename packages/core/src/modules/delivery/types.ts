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
  };

/**
 * Staff choices on the booking form. Money, item count and contents always
 * come from the saved order, never from the caller. `itemWeight` (kg) is the
 * parcel weight; the rest are booking options a courier may declare
 * (`bookingOptions`: Pathao's `deliveryType` and `itemType`).
 */
export interface ShipmentOptions {
  deliveryType?: number;
  itemType?: number;
  itemWeight?: number;
  note?: string;
}
