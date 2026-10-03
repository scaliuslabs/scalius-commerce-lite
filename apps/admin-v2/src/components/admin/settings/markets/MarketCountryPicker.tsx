// The countries a market sells to: the chosen ones as chips, then a search
// over every country. A country another market sells to is shown with that
// market's name and can't be chosen here (each country belongs to one market).
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { getCountries } from "@scalius/shared/customer-utils";
import { Input } from "~/components/ui/input";
import { getLocale, useMessages } from "~/i18n";
import { settingsMarketsMessages } from "~/i18n/settings-markets";

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames([getLocale() === "bn" ? "bn" : "en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

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
  const [search, setSearch] = useState("");
  const countries = useMemo(
    () => getCountries().map((code) => ({ code, name: countryName(code) })).sort((left, right) => left.name.localeCompare(right.name)),
    [],
  );
  const needle = search.trim().toLocaleLowerCase();
  const matches = countries.filter(
    (country) => !needle || country.name.toLocaleLowerCase().includes(needle) || country.code.toLowerCase() === needle,
  );
  const toggle = (code: string) =>
    onChange(selected.includes(code) ? selected.filter((item) => item !== code) : [...selected, code].sort());

  return (
    <div className="space-y-3">
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((code) => (
            <span key={code} className="inline-flex items-center gap-1 rounded-lg bg-secondary py-0.5 pl-2 pr-0.5 text-body text-secondary-foreground">
              {countryName(code)}
              <button
                type="button"
                disabled={disabled}
                aria-label={t("removeCountry", { country: countryName(code) })}
                className="grid size-8 place-items-center rounded-full hover:bg-muted-foreground/20 disabled:pointer-events-none disabled:opacity-50 sm:size-6"
                onClick={() => toggle(code)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          id={id}
          type="search"
          value={search}
          disabled={disabled}
          placeholder={t("countrySearch")}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
          className="pl-9"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {matches.length === 0 ? (
          <p className="p-4 text-center text-body text-muted-foreground">{t("countryNone")}</p>
        ) : (
          matches.map((country) => {
            const owner = taken.get(country.code);
            return (
              <label key={country.code} className="flex min-h-11 items-center gap-3 px-3 text-body hover:bg-muted/50">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={selected.includes(country.code)}
                  disabled={disabled || Boolean(owner)}
                  onChange={() => toggle(country.code)}
                />
                <span className="flex-1">{country.name}</span>
                {owner ? <span className="text-muted-foreground">{t("inMarket", { market: owner })}</span> : null}
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
