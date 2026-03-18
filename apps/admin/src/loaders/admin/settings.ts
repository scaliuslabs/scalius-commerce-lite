import { apiGet } from "@/lib/api-fetch";
import type {
  GeneralSettings,
  MetaConversionsSettingsResponse,
  DeliveryProviderRecord,
  FraudCheckerProvider,
} from "@/types/api-responses";

export async function getGeneralSettingsData(): Promise<{
  headerConfig: unknown;
  footerConfig: unknown;
}> {
  const result = await apiGet<GeneralSettings>(
    "/settings/general",
  ).catch(() => ({ headerConfig: {}, footerConfig: {} }));

  return {
    headerConfig: result.headerConfig || {},
    footerConfig: result.footerConfig || {},
  };
}

export async function getMetaConversionSettingsData() {
  const result = await apiGet<MetaConversionsSettingsResponse>("/settings/meta-conversions").catch(
    () => ({ settings: null }),
  );
  return result.settings ?? undefined;
}

export async function getDeliveryProvidersData() {
  try {
    const result = await apiGet<DeliveryProviderRecord[]>("/settings/delivery-providers");
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export async function getFraudCheckerProvidersData() {
  try {
    const result = await apiGet<FraudCheckerProvider[]>("/fraud-checker");
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}
