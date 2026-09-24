import { useFormContext, useWatch } from "react-hook-form";

import { LocationPicker, type LocationLevel } from "./location/LocationPicker";

/** The address fields a react-hook-form form keeps for the picker. */
interface LocationFields {
  city: string | null;
  zone: string | null;
  area: string | null;
  cityName?: string;
  zoneName?: string;
  areaName?: string;
}

/**
 * The shared City → Thana → Area picker bound to a react-hook-form form with
 * `city`/`zone`/`area` IDs and their `…Name` labels (customer form, order
 * details). Picking a level clears the levels under it.
 */
export function LocationSelector({ required }: { required?: Partial<Record<LocationLevel, boolean>> } = {}) {
  const form = useFormContext<LocationFields>();
  const [city, zone, area, cityName, zoneName, areaName] = useWatch({
    control: form.control,
    name: ["city", "zone", "area", "cityName", "zoneName", "areaName"],
  });
  const errors = form.formState.errors;
  const set = (name: keyof LocationFields, value: string | null, dirty: boolean) =>
    form.setValue(name, value as never, { shouldDirty: dirty, shouldValidate: dirty && form.formState.isSubmitted });

  return (
    <LocationPicker
      value={{
        city: city ? { id: city, name: cityName } : null,
        zone: zone ? { id: zone, name: zoneName } : null,
        area: area ? { id: area, name: areaName } : null,
      }}
      onChange={(next) => {
        set("city", next.city?.id ?? null, true);
        set("zone", next.zone?.id ?? null, true);
        set("area", next.area?.id ?? null, true);
        set("cityName", next.city?.name ?? "", false);
        set("zoneName", next.zone?.name ?? "", false);
        set("areaName", next.area?.name ?? "", false);
      }}
      required={required}
      errors={{
        city: errors.city?.message as string | undefined,
        zone: errors.zone?.message as string | undefined,
        area: errors.area?.message as string | undefined,
      }}
    />
  );
}
