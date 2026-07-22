import { useEffect, useRef, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { Loader2 } from "lucide-react";

import type { CustomerFormValues } from "~/lib/form-schemas";
import { getDeliveryLocations } from "~/lib/api-functions/delivery";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

interface Location {
  id: string;
  name: string;
  parentId?: string | null;
  type: "city" | "zone" | "area";
  externalIds: Record<string, string | number>;
  metadata: Record<string, unknown>;
  isActive: boolean;
  sortOrder: number;
}

const selectTriggerClassName = "h-11 sm:h-9";
const selectItemClassName = "min-h-11 sm:min-h-8";

export function LocationSelector() {
  const form = useFormContext<CustomerFormValues>();
  const cityValue = useWatch({ control: form.control, name: "city" });
  const zoneValue = useWatch({ control: form.control, name: "zone" });
  const areaValue = useWatch({ control: form.control, name: "area" });

  const [cities, setCities] = useState<Location[]>([]);
  const [zones, setZones] = useState<Location[]>([]);
  const [areas, setAreas] = useState<Location[]>([]);
  const [loadingCities, setLoadingCities] = useState(true);
  const [loadingZones, setLoadingZones] = useState(false);
  const [loadingAreas, setLoadingAreas] = useState(false);
  const zoneRequest = useRef(0);
  const areaRequest = useRef(0);

  useEffect(() => {
    let active = true;
    setLoadingCities(true);

    void getDeliveryLocations({ data: { type: "city" } })
      .then((result) => {
        if (active) setCities(result.locations as Location[]);
      })
      .catch((error: unknown) => {
        if (import.meta.env.DEV) console.error("Error loading cities:", error);
      })
      .finally(() => {
        if (active) setLoadingCities(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const requestId = ++zoneRequest.current;

    if (!cityValue) {
      setZones([]);
      setLoadingZones(false);
      return;
    }

    setLoadingZones(true);
    void getDeliveryLocations({
      data: { type: "zone", parentId: cityValue },
    })
      .then((result) => {
        if (requestId === zoneRequest.current) {
          setZones(result.locations as Location[]);
        }
      })
      .catch((error: unknown) => {
        if (import.meta.env.DEV) console.error("Error loading zones:", error);
      })
      .finally(() => {
        if (requestId === zoneRequest.current) setLoadingZones(false);
      });
  }, [cityValue]);

  useEffect(() => {
    const requestId = ++areaRequest.current;

    if (!zoneValue) {
      setAreas([]);
      setLoadingAreas(false);
      return;
    }

    setLoadingAreas(true);
    void getDeliveryLocations({
      data: { type: "area", parentId: zoneValue },
    })
      .then((result) => {
        if (requestId === areaRequest.current) {
          setAreas(result.locations as Location[]);
        }
      })
      .catch((error: unknown) => {
        if (import.meta.env.DEV) console.error("Error loading areas:", error);
      })
      .finally(() => {
        if (requestId === areaRequest.current) setLoadingAreas(false);
      });
  }, [zoneValue]);

  useEffect(() => {
    const selected = cities.find((city) => city.id === cityValue);
    if (selected && form.getValues("cityName") !== selected.name) {
      form.setValue("cityName", selected.name, { shouldDirty: false });
    }
  }, [cities, cityValue, form]);

  useEffect(() => {
    const selected = zones.find((zone) => zone.id === zoneValue);
    if (selected && form.getValues("zoneName") !== selected.name) {
      form.setValue("zoneName", selected.name, { shouldDirty: false });
    }
  }, [form, zoneValue, zones]);

  useEffect(() => {
    const selected = areas.find((area) => area.id === areaValue);
    if (selected && form.getValues("areaName") !== selected.name) {
      form.setValue("areaName", selected.name, { shouldDirty: false });
    }
  }, [areaValue, areas, form]);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <FormField
        control={form.control}
        name="city"
        render={({ field }) => (
          <FormItem>
            <FormLabel>City</FormLabel>
            <Select
              value={field.value || "_none"}
              onValueChange={(value) => {
                const cityId = value === "_none" ? null : value;
                if (cityId !== field.value) {
                  form.setValue("zone", null, { shouldDirty: true });
                  form.setValue("area", null, { shouldDirty: true });
                  form.setValue("zoneName", "", { shouldDirty: false });
                  form.setValue("areaName", "", { shouldDirty: false });
                }
                field.onChange(cityId);
                form.setValue(
                  "cityName",
                  cities.find((city) => city.id === cityId)?.name ?? "",
                  { shouldDirty: false },
                );
              }}
            >
              <FormControl>
                <SelectTrigger
                  className={selectTriggerClassName}
                  aria-busy={loadingCities}
                >
                  <SelectValue placeholder="Select city">
                    {loadingCities ? (
                      <span className="flex items-center">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading…
                      </span>
                    ) : field.value ? (
                      cities.find((city) => city.id === field.value)?.name ||
                      form.getValues("cityName") ||
                      field.value
                    ) : (
                      "Select city"
                    )}
                  </SelectValue>
                </SelectTrigger>
              </FormControl>
              <SelectContent className="rounded-xl bg-background">
                <SelectItem value="_none" className={selectItemClassName}>
                  No city selected
                </SelectItem>
                {cities.map((city) => (
                  <SelectItem
                    key={city.id}
                    value={city.id}
                    className={selectItemClassName}
                  >
                    {city.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="zone"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Zone</FormLabel>
            <Select
              value={field.value || "_none"}
              onValueChange={(value) => {
                const zoneId = value === "_none" ? null : value;
                if (zoneId !== field.value) {
                  form.setValue("area", null, { shouldDirty: true });
                  form.setValue("areaName", "", { shouldDirty: false });
                }
                field.onChange(zoneId);
                form.setValue(
                  "zoneName",
                  zones.find((zone) => zone.id === zoneId)?.name ?? "",
                  { shouldDirty: false },
                );
              }}
              disabled={!cityValue || loadingZones}
            >
              <FormControl>
                <SelectTrigger
                  className={selectTriggerClassName}
                  aria-busy={loadingZones}
                >
                  <SelectValue placeholder="Select zone">
                    {loadingZones ? (
                      <span className="flex items-center">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading…
                      </span>
                    ) : field.value ? (
                      zones.find((zone) => zone.id === field.value)?.name ||
                      form.getValues("zoneName") ||
                      field.value
                    ) : (
                      "Select zone"
                    )}
                  </SelectValue>
                </SelectTrigger>
              </FormControl>
              <SelectContent className="rounded-xl bg-background">
                <SelectItem value="_none" className={selectItemClassName}>
                  No zone selected
                </SelectItem>
                {zones.map((zone) => (
                  <SelectItem
                    key={zone.id}
                    value={zone.id}
                    className={selectItemClassName}
                  >
                    {zone.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="area"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Area</FormLabel>
            <Select
              value={field.value || "_none"}
              onValueChange={(value) => {
                const areaId = value === "_none" ? null : value;
                field.onChange(areaId);
                form.setValue(
                  "areaName",
                  areas.find((area) => area.id === areaId)?.name ?? "",
                  { shouldDirty: false },
                );
              }}
              disabled={!zoneValue || loadingAreas}
            >
              <FormControl>
                <SelectTrigger
                  className={selectTriggerClassName}
                  aria-busy={loadingAreas}
                >
                  <SelectValue placeholder="Select area">
                    {loadingAreas ? (
                      <span className="flex items-center">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading…
                      </span>
                    ) : field.value ? (
                      areas.find((area) => area.id === field.value)?.name ||
                      form.getValues("areaName") ||
                      field.value
                    ) : (
                      "Select area"
                    )}
                  </SelectValue>
                </SelectTrigger>
              </FormControl>
              <SelectContent className="rounded-xl bg-background">
                <SelectItem value="_none" className={selectItemClassName}>
                  No area selected
                </SelectItem>
                {areas.map((area) => (
                  <SelectItem
                    key={area.id}
                    value={area.id}
                    className={selectItemClassName}
                  >
                    {area.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
