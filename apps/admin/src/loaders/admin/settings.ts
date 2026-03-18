import { apiGet } from "@/lib/api-server";
import type { HeaderConfig } from "@/components/admin/header-builder/types";
import type { FooterConfig } from "@/components/admin/footer-builder/types";
import type {
  GeneralSettings,
  MetaConversionsSettingsResponse,
  DeliveryProviderRecord,
  FraudCheckerProvider,
} from "@/types/api-responses";

export async function getGeneralSettingsData(): Promise<{
  headerConfig: HeaderConfig | null;
  footerConfig: FooterConfig | null;
}> {
  const result = await apiGet<GeneralSettings>(
    "/settings/general",
  ).catch(() => ({ headerConfig: null, footerConfig: null }));

  return {
    headerConfig: result.headerConfig ? (result.headerConfig as unknown as HeaderConfig) : null,
    footerConfig: result.footerConfig ? (result.footerConfig as unknown as FooterConfig) : null,
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
