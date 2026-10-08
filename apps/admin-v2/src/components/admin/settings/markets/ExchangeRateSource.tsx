/**
 * "Exchange rate source" of a market that sells in its own currency (Settings
 * → Markets → one market → Currency): the rate the merchant types (manual,
 * the default) or an exchange rate app's. With an app, the typed rate goes away:
 * the page shows the app's rate as a sentence, and the app refreshes it on a
 * schedule. Saving a new app asks the app for the rate at once; the API refuses
 * the save with a reason when the app has no rate.
 */
import { useQuery } from "@tanstack/react-query";
import { MANUAL_FX_RATE_SOURCE_ID } from "@scalius/shared/market-pricing";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { listDateLabel } from "~/components/admin/data-table/ListDate";
import { useMessages } from "~/i18n";
import { dataTableMessages } from "~/i18n/data-table";
import { settingsMarketsMessages } from "~/i18n/settings-markets";
import { appProvidersQuery } from "~/lib/api-query-options/settings-screens";
import { useProviderPortAccess } from "~/lib/provider-port-access";
import { SettingsField } from "../SettingsPage";
import type { MarketForm } from "./market-form";

export function ExchangeRateSource({ values, canEdit, setValues }: {
  values: MarketForm;
  canEdit: boolean;
  setValues: (update: (draft: MarketForm) => MarketForm) => void;
}) {
  const t = useMessages(settingsMarketsMessages);
  const when = useMessages(dataTableMessages);
  const access = useProviderPortAccess("fx");
  const apps = useQuery({ ...appProvidersQuery("fx"), enabled: access.canView }).data ?? [];
  const source = values.fxRateSource;
  const app = apps.find((provider) => provider.id === source);
  // Nothing to choose from: a market keeps its typed rate and the card stays as it was.
  if (source === MANUAL_FX_RATE_SOURCE_ID && apps.length === 0) return null;
  const options = [
    { value: MANUAL_FX_RATE_SOURCE_ID, label: t("rateSourceManual") },
    ...apps.map((provider) => ({ value: provider.id, label: provider.name, description: t("rateSourceByApp", { app: provider.appName }) })),
    // An app that is no longer installed stays visible, so the choice can be changed.
    ...(source !== MANUAL_FX_RATE_SOURCE_ID && !app ? [{ value: source, label: source }] : []),
  ];
  const asOf = values.fxRateAsOf ? new Date(values.fxRateAsOf) : null;
  const saved = source === values.savedFxRateSource && values.fxRate;
  return (
    <>
      <SettingsField id="market-rate-source" label={t("rateSource")} help={source === MANUAL_FX_RATE_SOURCE_ID ? t("rateSourceManualHelp") : t("rateSourceAppHelp")}>
        <SearchableSelect
          id="market-rate-source"
          value={source}
          disabled={!canEdit}
          triggerClassName="block w-full sm:w-80"
          options={options}
          onValueChange={(next) => setValues((draft) => ({ ...draft, fxRateSource: next }))}
        />
      </SettingsField>
      {source === MANUAL_FX_RATE_SOURCE_ID ? null : (
        <p className="text-body" aria-live="polite">
          {saved
            ? t("rateFromApp", {
              shop: values.shopCurrencyCode,
              rate: values.fxRate!,
              currency: values.currencyCode,
              when: asOf && !Number.isNaN(asOf.getTime()) ? listDateLabel(asOf, new Date(), when) : "—",
              app: app?.name ?? source,
            })
            : t("rateFromAppOnSave", { app: app?.name ?? source })}
        </p>
      )}
    </>
  );
}
