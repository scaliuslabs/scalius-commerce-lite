// Choosing countries (Settings → Markets, shipping zones): a search over the
// countries, a list in a box of fixed height (filtering changes its rows,
// never its size), and the chosen ones as chips below it. The search field is
// first and the list never resizes, so nothing above the chips moves when a
// country is picked, and the chip row keeps the height of one row (it shows a
// hint while empty) so the first pick doesn't push what follows.
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "~/components/ui/input";
import { countryName } from "~/lib/country-name";

export interface CountryChecklistCopy {
  search: string;
  none: string;
  noneSelected: string;
  remove: (country: string) => string;
}

export function CountryChecklist({
  id,
  countries,
  selected,
  notes,
  disabledCodes,
  disabled = false,
  invalid = false,
  describedBy,
  copy,
  onChange,
}: {
  id: string;
  /** ISO codes to choose from. */
  countries: readonly string[];
  selected: readonly string[];
  /** A short note beside a country (the market or zone that holds it). */
  notes?: ReadonlyMap<string, string>;
  /** Countries that can't be chosen here. */
  disabledCodes?: ReadonlySet<string>;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  copy: CountryChecklistCopy;
  onChange: (countries: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const named = useMemo(
    () => countries.map((code) => ({ code, name: countryName(code) })).sort((left, right) => left.name.localeCompare(right.name)),
    [countries],
  );
  const needle = search.trim().toLocaleLowerCase();
  const matches = named.filter(
    (country) => !needle || country.name.toLocaleLowerCase().includes(needle) || country.code.toLowerCase() === needle,
  );
  const toggle = (code: string) =>
    onChange(selected.includes(code) ? selected.filter((item) => item !== code) : [...selected, code].sort());

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          id={id}
          type="search"
          value={search}
          disabled={disabled}
          placeholder={copy.search}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
          className="pl-9"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div data-slot="country-list" className="h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {matches.length === 0 ? (
          <p className="p-4 text-center text-body text-muted-foreground">{copy.none}</p>
        ) : (
          matches.map((country) => {
            const note = notes?.get(country.code);
            return (
              <label key={country.code} className="flex min-h-11 items-center gap-3 px-3 text-body hover:bg-muted/50">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={selected.includes(country.code)}
                  disabled={disabled || Boolean(disabledCodes?.has(country.code))}
                  onChange={() => toggle(country.code)}
                />
                <span className="flex-1">{country.name}</span>
                {note ? <span className="text-muted-foreground">{note}</span> : null}
              </label>
            );
          })
        )}
      </div>
      <div data-slot="country-chips" className="flex min-h-9 max-h-24 flex-wrap items-center gap-1.5 overflow-y-auto sm:min-h-7">
        {selected.length === 0 ? (
          <p className="text-body text-muted-foreground">{copy.noneSelected}</p>
        ) : (
          selected.map((code) => (
            <span key={code} className="inline-flex items-center gap-1 rounded-lg bg-secondary py-0.5 pl-2 pr-0.5 text-body text-secondary-foreground">
              {countryName(code)}
              <button
                type="button"
                disabled={disabled}
                aria-label={copy.remove(countryName(code))}
                className="grid size-8 place-items-center rounded-full hover:bg-muted-foreground/20 disabled:pointer-events-none disabled:opacity-50 sm:size-6"
                onClick={() => toggle(code)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </span>
          ))
        )}
      </div>
    </div>
  );
}
