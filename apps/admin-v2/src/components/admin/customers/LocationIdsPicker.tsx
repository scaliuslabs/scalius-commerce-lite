import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { SearchableSelect } from "~/components/ui/searchable-select";
import {
  deliveryLocationByIdQueryOptions,
  deliveryLocationLoader,
  locationOption,
} from "~/lib/api-query-options/delivery";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { customerSegmentMessages } from "~/i18n/customer-segments";
import { SEGMENT_VALUES_MAX } from "./segment-draft";

/** A chosen place, named from the search that found it or looked up by its id. */
function PlaceChip({ id, name, disabled, onRemove }: { id: string; name?: string; disabled: boolean; onRemove: () => void }) {
  const t = useMessages(customerSegmentMessages);
  const lookup = useQuery({ ...deliveryLocationByIdQueryOptions(id), enabled: !name });
  const label = name ?? lookup.data?.name ?? id;
  return (
    <li className="flex min-w-0 items-center gap-1 rounded-lg bg-secondary py-0.5 ps-2 text-body">
      <span className="min-w-0 break-words">{label}</span>
      <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("removePlace", { name: label })} onClick={onRemove}>
        <X aria-hidden="true" />
      </Button>
    </li>
  );
}

/**
 * Cities or thanas for a segment filter: chips for the chosen ones and a
 * server-searched picker that adds one at a time (the delivery areas list).
 */
export function LocationIdsPicker({
  id,
  type,
  ids,
  onChange,
  disabled = false,
  invalid = false,
  describedBy,
}: {
  id: string;
  type: "city" | "zone";
  ids: readonly string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const t = useMessages(customerSegmentMessages);
  // Names of places found by the search, so a new chip needs no lookup.
  const [names] = useState(() => new Map<string, string>());
  const full = ids.length >= SEGMENT_VALUES_MAX;
  return (
    <div className="space-y-2">
      {ids.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t(type === "city" ? "field.city" : "field.zone")}>
          {ids.map((placeId) => (
            <PlaceChip
              key={placeId}
              id={placeId}
              name={names.get(placeId)}
              disabled={disabled}
              onRemove={() => onChange(ids.filter((other) => other !== placeId))}
            />
          ))}
        </ul>
      ) : null}
      <SearchableSelect
        id={id}
        value=""
        disabled={disabled || full}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        ariaLabel={t(type === "city" ? "addCity" : "addZone")}
        placeholder={t(type === "city" ? "addCity" : "addZone")}
        searchPlaceholder={t("searchPlaces")}
        emptyMessage={t("noPlaces")}
        triggerClassName="w-full"
        load={deliveryLocationLoader({
          type,
          toOption: (location) => {
            names.set(location.id, location.name);
            return { ...locationOption(location), disabled: ids.includes(location.id) };
          },
        })}
        queryKey={[...queryKeys.settings.deliveryLocations(), "picker", "segment", type, ids.join(",")]}
        onValueChange={(value) => {
          if (value && !ids.includes(value) && !full) onChange([...ids, value]);
        }}
      />
    </div>
  );
}
