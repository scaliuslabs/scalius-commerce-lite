import { useQuery } from "@tanstack/react-query";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import type { AppPaymentProvider } from "~/components/admin/settings/payment-method-rows";
import { retiredPaymentMethod } from "~/lib/bangladesh-pack";
import { useProviderPortAccess } from "~/lib/provider-port-access";
import { appPaymentMethodNames, appPaymentProvidersQuery } from "~/lib/api-query-options/payment-providers";

/** Installed apps change rarely; an order page needn't re-read them on every visit. */
const APP_NAMES_STALE_MS = 5 * 60 * 1000;

/** Whether any of these stored methods is an app's (`<plugin id>:<provider id>`, or a retired built-in id an app replaced). */
export function hasAppPaymentMethod(methods: readonly (string | null | undefined)[]): boolean {
  return methods.some((method) => isQualifiedProviderId(method) || retiredPaymentMethod(method) !== null);
}

/**
 * The names of installed apps' payment providers, by method id, for labelling
 * orders, payments and refunds (`paymentMethodLabel`). Read only when `needed`
 * (a screen shows an app method) and the staff member may read payment
 * settings; otherwise app methods read as their provider id in words.
 */
export function useAppPaymentMethodNames(needed: boolean): ReadonlyMap<string, string> | undefined {
  const canRead = useProviderPortAccess("payment").canView;
  return useQuery({
    ...appPaymentProvidersQuery,
    enabled: needed && canRead,
    staleTime: APP_NAMES_STALE_MS,
    select: appPaymentMethodNames,
  }).data;
}

/**
 * The installed app provider an order's method means (a retired built-in id:
 * the provider that replaced it), when the staff member may read them:
 * `undefined` while unknown, `null` when its app is not installed.
 */
export function useOrderPaymentProvider(method: string | null | undefined, needed: boolean): AppPaymentProvider | null | undefined {
  const canRead = useProviderPortAccess("payment").canView;
  const id = retiredPaymentMethod(method)?.replacement ?? method ?? "";
  const providers = useQuery({
    ...appPaymentProvidersQuery,
    enabled: needed && canRead && isQualifiedProviderId(id),
    staleTime: APP_NAMES_STALE_MS,
  });
  if (!needed || !canRead || !isQualifiedProviderId(id) || !providers.data) return undefined;
  return providers.data.find((provider) => provider.id === id) ?? null;
}
