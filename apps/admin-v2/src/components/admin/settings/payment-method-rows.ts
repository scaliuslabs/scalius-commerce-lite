// The rows of the payment methods card: cash on delivery, every gateway the
// API says the store can offer (built in, then active apps' providers), and
// the installed app providers that can't be offered yet (not activated, not
// set up). Built from the API's lists, never from a fixed set of ids.

import { parseQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { appPaymentMethodFallbackName } from "~/lib/app-payment-method";
import type { ChargeCurrencies, GatewayStatus } from "./payment-method-outcome";

export const COD_METHOD = "cod";

/** A gateway as `GET /admin/settings/payment-methods` lists it. */
export interface PaymentGatewayInfo {
  id: string;
  label: string;
  /** The app that provides it; null for a built-in gateway. */
  pluginId: string | null;
  chargeCurrencies: ChargeCurrencies;
}

/** An installed app's payment provider as `GET /admin/settings/providers?kind=payment` lists it. */
export interface AppPaymentProvider {
  id: string;
  pluginId: string;
  appName: string;
  /** The app's icon (its brand mark for a wallet app), or null. */
  appIcon?: string | null;
  /** The provider's own mark (a pack's providers are different brands), else the app's icon. */
  icon?: string | null;
  name: string;
  canTestConnection: boolean;
  readiness: {
    configured: boolean;
    enabled: boolean;
    usable: boolean;
    missingFields: string[];
    credentialErrors: string[];
    blockedReason?: string;
  };
  environment: "test" | "live" | "unknown";
}

export interface PaymentMethodRow {
  id: string;
  kind: "cod" | "built_in" | "app";
  /** The gateway's or app provider's own name (built-in names also have catalog copy). */
  name: string;
  /** The app's plugin id, for its page under Apps. */
  pluginId: string | null;
  appName: string | null;
  /** The provider's mark (else its app's icon), shown as the method's mark. */
  appIcon: string | null;
  canTestConnection: boolean;
  chargeCurrencies: ChargeCurrencies;
  status: GatewayStatus | undefined;
}

/** An app provider's readiness in the payment methods card's terms. */
function appProviderStatus(provider: AppPaymentProvider): GatewayStatus {
  const { readiness } = provider;
  return {
    configured: readiness.configured,
    enabled: readiness.enabled,
    usable: readiness.usable,
    missingFields: readiness.missingFields,
    credentialErrors: readiness.credentialErrors,
    ...(readiness.blockedReason ? { blockedReason: readiness.blockedReason } : {}),
    providerEnabled: readiness.enabled,
    environment: provider.environment,
  };
}

/**
 * Every method the merchant can see: the ones turned on in their checkout
 * order, then the rest (cash on delivery, the API's gateways in its order,
 * then app providers that can't be offered yet). A saved method whose app
 * was removed is not a row: the API leaves it out of its read and drops it
 * on the next save, so it never shows as on or blocks saving.
 */
export function paymentMethodRows(input: {
  enabledMethods: readonly string[];
  gateways: readonly PaymentGatewayInfo[];
  gatewayStatus: Partial<Record<string, GatewayStatus>>;
  appProviders: readonly AppPaymentProvider[];
  /** The installed providers were read; until then a saved app method is kept as a row. */
  appProvidersKnown: boolean;
}): PaymentMethodRow[] {
  const gateways = new Map(input.gateways.map((gateway) => [gateway.id, gateway]));
  const providers = new Map(input.appProviders.map((provider) => [provider.id, provider]));
  const catalog = [
    COD_METHOD,
    ...input.gateways.map((gateway) => gateway.id),
    ...input.appProviders.map((provider) => provider.id),
  ];
  const order = [...new Set([...input.enabledMethods, ...catalog])];

  return order.flatMap((id): PaymentMethodRow[] => {
    if (id === COD_METHOD) {
      return [{
        id,
        kind: "cod",
        name: id,
        pluginId: null,
        appName: null,
        appIcon: null,
        canTestConnection: false,
        chargeCurrencies: "any",
        status: input.gatewayStatus[id],
      }];
    }
    const gateway = gateways.get(id);
    const provider = providers.get(id);
    const app = parseQualifiedProviderId(id);
    if (gateway && gateway.pluginId === null && !app) {
      return [{
        id,
        kind: "built_in",
        name: gateway.label,
        pluginId: null,
        appName: null,
        appIcon: null,
        canTestConnection: false,
        chargeCurrencies: gateway.chargeCurrencies,
        status: input.gatewayStatus[id],
      }];
    }
    // Its app was removed (a read racing the removal): the next save drops it.
    if (!gateway && !provider && input.appProvidersKnown) return [];
    return [{
      id,
      kind: "app",
      name: provider?.name ?? gateway?.label ?? appPaymentMethodFallbackName(id) ?? id,
      pluginId: gateway?.pluginId ?? provider?.pluginId ?? app?.pluginId ?? null,
      appName: provider?.appName ?? null,
      appIcon: provider?.icon ?? provider?.appIcon ?? null,
      canTestConnection: provider?.canTestConnection ?? false,
      chargeCurrencies: gateway?.chargeCurrencies ?? "any",
      // The checkout's own verdict (currency included) when the app is active.
      status: input.gatewayStatus[id] ?? (provider ? appProviderStatus(provider) : undefined),
    }];
  });
}
