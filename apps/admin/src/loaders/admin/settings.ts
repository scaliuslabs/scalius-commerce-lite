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
  // apiGet calls the API directly (not through the admin proxy) and
  // unwraps { success, data: T } → T. So result IS the array.
  try {
    const result = await apiGet<any>("/settings/delivery-providers");
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export async function getFraudCheckerProvidersData() {
  // Fraud checker is mounted at /admin/fraud-checker (not under /settings).
  // API returns ok(c, maskedProviders) — an array with apiKey already masked.
  // apiGet unwraps { success, data: T } → T. So result IS the array.
  try {
    const result = await apiGet<any>("/fraud-checker");
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}
