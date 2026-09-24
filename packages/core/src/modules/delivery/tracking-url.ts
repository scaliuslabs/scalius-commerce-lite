/**
 * The courier's public tracking page for a parcel, or null when the courier
 * has none (manual shipments) or there is no tracking ID yet.
 */
export function getTrackingUrl(providerType: string, trackingId: string | null): string | null {
  if (!trackingId) return null;
  switch (providerType) {
    case "pathao":
      return `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(trackingId)}`;
    case "steadfast":
      return `https://steadfast.com.bd/t/${encodeURIComponent(trackingId)}`;
    default:
      return null;
  }
}
