// Shipping profiles (Settings → Shipping): its own small module, so the
// product and discount editors that list profiles load nothing else.
import { apiClient, apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";

/** The dashboard's shipping settings routes (dashboard.shipping_methods.*, shipping_zones.*, shipping_profiles.*). */
export const SHIPPING_SETTINGS_URL = "/api/v1/admin/settings/shipping-methods";
export const PROFILES_URL = `${SHIPPING_SETTINGS_URL}/profiles`;

/** A shipping profile's own price behind one delivery option (amounts in major units). */
export interface ShippingProfileRate {
  id?: string;
  methodId: string;
  fee: number;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  minSubtotal: number | null;
  maxSubtotal: number | null;
  freeOver: number | null;
}

export interface ShippingProfile {
  id: string;
  name: string;
  isDefault: boolean;
  freeDelivery: boolean;
  defaultWeightGrams: number | null;
  revision: number;
  productCount: number;
  unweighedProductCount: number;
  rates: ShippingProfileRate[];
}

export const shippingProfilesQuery = {
  queryKey: queryKeys.settings.shippingProfiles(),
  queryFn: async () => (await apiData(apiClient.get<{ 200: { data: { profiles: ShippingProfile[] } } }>({ url: PROFILES_URL }))).profiles,
};
