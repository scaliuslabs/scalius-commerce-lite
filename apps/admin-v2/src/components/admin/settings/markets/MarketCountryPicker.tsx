// The countries a market sells to (the shared country checklist). A country
// another market sells to is shown with that market's name and can't be
// chosen here (each country belongs to one market).
import { useMemo } from "react";
import { getCountries } from "@scalius/shared/customer-utils";
import { CountryChecklist } from "~/components/admin/shared/CountryChecklist";
import { useMessages } from "~/i18n";
import { settingsMarketsMessages } from "~/i18n/settings-markets";

export { countryName } from "~/lib/country-name";

export function MarketCountryPicker({
  id,
  selected,
  taken,
  disabled = false,
  invalid = false,
  describedBy,
  onChange,
}: {
  id: string;
  selected: readonly string[];
  /** Country code → the name of the market that sells to it. */
  taken: ReadonlyMap<string, string>;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (countries: string[]) => void;
}) {
  const t = useMessages(settingsMarketsMessages);
  const countries = useMemo(() => getCountries(), []);
  const notes = useMemo(
    () => new Map([...taken].map(([code, market]) => [code, t("inMarket", { market })])),
    [taken, t],
  );
  return (
    <CountryChecklist
      id={id}
      countries={countries}
      selected={selected}
      notes={notes}
      disabledCodes={new Set(taken.keys())}
      disabled={disabled}
      invalid={invalid}
      describedBy={describedBy}
      copy={{
        search: t("countrySearch"),
        none: t("countryNone"),
        noneSelected: t("countryNoneSelected"),
        remove: (country) => t("removeCountry", { country }),
      }}
      onChange={onChange}
    />
  );
}
