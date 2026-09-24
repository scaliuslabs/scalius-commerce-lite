import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { cn } from "@scalius/shared/utils";
import { Label } from "~/components/ui/label";
import { SearchableSelect, type SearchableSelectOption } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { locationMessages } from "~/i18n/location";
import {
  deliveryLocationByIdQueryOptions,
  deliveryLocationLoader,
  type DeliveryLocationsQuery,
} from "~/lib/api-query-options/delivery";
import { queryKeys } from "~/lib/query-keys";

export type LocationLevel = "city" | "zone" | "area";

/** A chosen place: its ID, and its name when known (saved with the record). */
export interface PickedPlace {
  id: string;
  name?: string | null;
}

export type LocationValue = Record<LocationLevel, PickedPlace | null>;

export const EMPTY_LOCATION: LocationValue = { city: null, zone: null, area: null };

const LEVELS: readonly LocationLevel[] = ["city", "zone", "area"];

const COPY = {
  city: { label: "city", select: "selectCity", search: "searchCities", empty: "noCities" },
  zone: { label: "zone", select: "selectZone", search: "searchZones", empty: "noZones" },
  area: { label: "area", select: "selectArea", search: "searchAreas", empty: "noAreas" },
} as const;

/** Where the loader for each level looks. */
function levelQuery(level: LocationLevel, value: LocationValue): { type: DeliveryLocationsQuery["type"]; parentId?: string } | null {
  if (level === "city") return { type: "city" };
  const parent = level === "zone" ? value.city : value.zone;
  return parent ? { type: level, parentId: parent.id } : null;
}

/** A name for a saved ID when the record did not keep one. */
function useSavedName(place: PickedPlace | null) {
  const query = useQuery({
    ...deliveryLocationByIdQueryOptions(place?.id ?? ""),
    enabled: Boolean(place?.id && !place.name),
  });
  return place?.name || query.data?.name || undefined;
}

export interface LocationPickerProps {
  value: LocationValue;
  /**
   * The whole new value. Picking or clearing a level clears the levels under
   * it; `level` is the one the merchant changed.
   */
  onChange: (next: LocationValue, level: LocationLevel) => void;
  /** Element ids of the three fields (for labels, errors and focus). */
  ids?: Partial<Record<LocationLevel, string>>;
  /** Field-level messages, shown under each field. */
  errors?: Partial<Record<LocationLevel, string | undefined>>;
  required?: Partial<Record<LocationLevel, boolean>>;
  /** Show a clear button on these levels (defaults: area only, or any level that is not required). */
  clearable?: Partial<Record<LocationLevel, boolean>>;
  disabled?: boolean;
  /** The trigger buttons, e.g. to move focus from a previous field. */
  refs?: Partial<Record<LocationLevel, React.Ref<HTMLButtonElement>>>;
  /** Also offer inactive places (settings screens); pickers for orders and customers do not. */
  includeInactive?: boolean;
  /** Grid layout of the three fields. */
  className?: string;
}

/**
 * City → Thana → Area, each a server-searched, paged combobox filtered by the
 * level above (search matches any script, Bangla included). Use it wherever
 * the dashboard picks a delivery address.
 */
export function LocationPicker({
  value,
  onChange,
  ids,
  errors,
  required,
  clearable,
  disabled = false,
  refs,
  includeInactive = false,
  className,
}: LocationPickerProps) {
  const t = useMessages(locationMessages);
  const autoId = React.useId();
  const triggers = React.useRef<Partial<Record<LocationLevel, HTMLButtonElement | null>>>({});
  const names = {
    city: useSavedName(value.city),
    zone: useSavedName(value.zone),
    area: useSavedName(value.area),
  };

  const pick = (level: LocationLevel, option: SearchableSelectOption | null) => {
    const place = option ? { id: option.value, name: option.label } : null;
    const next: LocationValue =
      level === "city"
        ? { city: place, zone: null, area: null }
        : level === "zone"
          ? { ...value, zone: place, area: null }
          : { ...value, area: place };
    onChange(next, level);
    // The next level is where the merchant goes next.
    const following = LEVELS[LEVELS.indexOf(level) + 1];
    if (place && following) requestAnimationFrame(() => triggers.current[following]?.focus());
  };

  return (
    <div className={cn("grid gap-3", className)}>
      {LEVELS.map((level) => {
        const id = ids?.[level] ?? `${autoId}-${level}`;
        const query = levelQuery(level, value);
        const error = errors?.[level];
        const errorId = `${id}-error`;
        const copy = COPY[level];
        const canClear = clearable?.[level] ?? (level === "area" || !required?.[level]);
        const externalRef = refs?.[level];
        return (
          <div key={level} className="grid gap-2">
            <Label htmlFor={id}>{t(copy.label)}</Label>
            <SearchableSelect
              id={id}
              triggerRef={(node) => {
                triggers.current[level] = node;
                if (typeof externalRef === "function") externalRef(node);
                else if (externalRef) (externalRef as React.MutableRefObject<HTMLButtonElement | null>).current = node;
              }}
              value={value[level]?.id ?? ""}
              selectedLabel={names[level]}
              onValueChange={(_, option) => pick(level, option)}
              load={deliveryLocationLoader({ ...(query ?? { type: level }), includeInactive })}
              queryKey={[...queryKeys.settings.deliveryLocations(), "picker", level, query?.parentId ?? null, includeInactive]}
              disabled={disabled || !query}
              required={required?.[level]}
              clearable={canClear}
              placeholder={query ? t(copy.select) : t(level === "zone" ? "cityFirst" : "zoneFirst")}
              searchPlaceholder={t(copy.search)}
              emptyMessage={t(copy.empty)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              triggerClassName="w-full"
            />
            {error ? (
              <p id={errorId} className="text-body text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
