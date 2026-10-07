import { retiredCourierTrackingUrl } from "../../integrations/retired-providers";

/**
 * The public tracking page of a shipment without a saved one: only a parcel a
 * retired built-in courier booked before it moved into an app (an app
 * courier's page is saved with the shipment when it is booked). Null for
 * manual shipments and when there is no tracking ID yet.
 */
export function getTrackingUrl(providerType: string, trackingId: string | null): string | null {
  return retiredCourierTrackingUrl(providerType, trackingId);
}
