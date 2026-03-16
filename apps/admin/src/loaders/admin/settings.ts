import { apiGet } from "@/lib/api-fetch";

export async function getGeneralSettingsData(): Promise<{
  headerConfig: any;
  footerConfig: any;
}> {
  const result = await apiGet<{ headerConfig: any; footerConfig: any }>(
    "/settings/general",
  ).catch(() => ({ headerConfig: {}, footerConfig: {} }));

  return {
    headerConfig: result.headerConfig || {},
    footerConfig: result.footerConfig || {},
  };
}

export async function getMetaConversionSettingsData() {
  // API returns ok(c, { data: maskedSettings }) — after proxy unwrap: { data: ... }
  // apiGet strips success: { data: ... }
  const result = await apiGet<{ data: any }>("/settings/meta-conversions").catch(
    () => ({ data: undefined }),
  );
  return result.data ?? undefined;
}

export async function getDeliveryProvidersData() {
  // API returns ok(c, maskedProviders) where maskedProviders is an array.
  // Proxy: arrays are NOT unwrapped, body stays { success, data: [...] }.
  // apiGet strips success -> returns { data: [...] }.
  try {
    const result = await apiGet<any>("/settings/delivery-providers");
    // Result is { data: [...] } because the proxy doesn't unwrap arrays
    return Array.isArray(result.data) ? result.data : [];
  } catch {
    return [];
  }
}
