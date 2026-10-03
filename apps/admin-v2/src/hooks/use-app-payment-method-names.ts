import { useQuery } from "@tanstack/react-query";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { appPaymentMethodNames, appPaymentProvidersQuery } from "~/lib/api-query-options/payment-providers";

/** Installed apps change rarely; an order page needn't re-read them on every visit. */
const APP_NAMES_STALE_MS = 5 * 60 * 1000;

/** Whether any of these stored methods is an app's (`<plugin id>:<provider id>`). */
export function hasAppPaymentMethod(methods: readonly (string | null | undefined)[]): boolean {
  return methods.some((method) => isQualifiedProviderId(method));
}

/**
 * The names of installed apps' payment providers, by method id, for labelling
 * orders, payments and refunds (`paymentMethodLabel`). Read only when `needed`
 * (a screen shows an app method) and the staff member may read payment
 * settings; otherwise app methods read as their provider id in words.
 */
export function useAppPaymentMethodNames(needed: boolean): ReadonlyMap<string, string> | undefined {
  const canRead = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW);
  return useQuery({
    ...appPaymentProvidersQuery,
    enabled: needed && canRead,
    staleTime: APP_NAMES_STALE_MS,
    select: appPaymentMethodNames,
  }).data;
}
