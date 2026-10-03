// Installed apps' payment providers (`GET /admin/settings/providers?kind=payment`),
// inactive and unconfigured ones too, with their readiness. The payments
// settings list them beside the built-in gateways; order screens read their
// names, since orders store an app method as `<plugin id>:<provider id>`.
import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminSettingsProviders } from "@scalius/api-client/sdk";
import type { AppPaymentProvider } from "~/components/admin/settings/payment-method-rows";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

export const appPaymentProvidersQuery = queryOptions({
  queryKey: queryKeys.settings.appProviders("payment"),
  queryFn: async (): Promise<AppPaymentProvider[]> =>
    (await apiData(getApiV1AdminSettingsProviders({ query: { kind: "payment" } }))).providers,
});

/** Provider names by method id, for labelling orders. */
export function appPaymentMethodNames(providers: readonly Pick<AppPaymentProvider, "id" | "name">[]): ReadonlyMap<string, string> {
  return new Map(providers.map((provider) => [provider.id, provider.name]));
}
