import { useEffect, useState } from "react";
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
import { useFormContext } from "react-hook-form";
import { Loader2 } from "lucide-react";

interface Location {
  id: string;
  name: string;
  parentId?: string | null;
  type: "city" | "zone" | "area";
  externalIds: Record<string, string | number>;
  metadata: Record<string, any>;
  isActive: boolean;
  sortOrder: number;
}

export function LocationSelector() {
  const form = useFormContext();

  const [cities, setCities] = useState<Location[]>([]);
  const [zones, setZones] = useState<Location[]>([]);
  const [areas, setAreas] = useState<Location[]>([]);

  const [loadingCities, setLoadingCities] = useState(false);
  const [loadingZones, setLoadingZones] = useState(false);
  const [loadingAreas, setLoadingAreas] = useState(false);

  // Log initial values when component first mounts
  console.log("LocationSelector initial values:", {
    city: form.getValues("city"),
    zone: form.getValues("zone"),
    area: form.getValues("area"),
    cityName: form.getValues("cityName"),
    zoneName: form.getValues("zoneName"),
    areaName: form.getValues("areaName"),
  });

  // Load cities on initial mount and handle initial values
  useEffect(() => {
    const loadInitialData = async () => {
      // Keep record of initial values
      const initialCity = form.getValues("city");
      const initialZone = form.getValues("zone");
      const initialArea = form.getValues("area");

      console.log("Initial location values:", {
        initialCity,
        initialZone,
        initialArea,
      });

      // Set loading states
      setLoadingCities(true);

      try {
        // Load cities
        const response = await fetch(
          "/api/settings/delivery-locations?type=city",
        );
        if (!response.ok) throw new Error("Failed to load cities");
        const result = await response.json();
        setCities(result.data);

        // If we have a city value, proceed to load zones
        if (initialCity) {
          setLoadingZones(true);
          try {
            const zoneResponse = await fetch(
              `/api/settings/delivery-locations?type=zone&parentId=${initialCity}`,
            );
            if (!zoneResponse.ok) throw new Error("Failed to load zones");
            const zoneResult = await zoneResponse.json();
            setZones(zoneResult.data);

            // If we have a zone value, proceed to load areas
            if (initialZone) {
              setLoadingAreas(true);
              try {
                const areaResponse = await fetch(
                  `/api/settings/delivery-locations?type=area&parentId=${initialZone}`,
                );
                if (!areaResponse.ok) throw new Error("Failed to load areas");
                const areaResult = await areaResponse.json();
                setAreas(areaResult.data);
              } catch (error) {
                console.error("Error loading initial areas:", error);
              } finally {
                setLoadingAreas(false);
              }
            }
          } catch (error) {
            console.error("Error loading initial zones:", error);
          } finally {
            setLoadingZones(false);
          }
        }
      } catch (error) {
        console.error("Error loading initial cities:", error);
      } finally {
        setLoadingCities(false);
      }
    };

    loadInitialData();
  }, []);

  // Load zones when city changes
  useEffect(() => {
    const city = form.getValues("city");
    if (city) {
      // Set the city name in the form
      const selectedCity = cities.find((c) => c.id === city);
      if (selectedCity) {
        form.setValue("cityName", selectedCity.name);
        console.log("Set cityName to", selectedCity.name);
      }

      loadZones(city);
    } else {
      setZones([]);
      setAreas([]);
      form.setValue("zone", "");
      form.setValue("area", "");
      form.setValue("cityName", "");
      form.setValue("zoneName", "");
      form.setValue("areaName", "");
    }
  }, [form.watch("city"), cities]);

  // Load areas when zone changes
  useEffect(() => {
    const zone = form.getValues("zone");
    if (zone) {
      // Set the zone name in the form
      const selectedZone = zones.find((z) => z.id === zone);
      if (selectedZone) {
        form.setValue("zoneName", selectedZone.name);
        console.log("Set zoneName to", selectedZone.name);
      }

      loadAreas(zone);
    } else {
      setAreas([]);
      form.setValue("area", "");
      form.setValue("zoneName", "");
      form.setValue("areaName", "");
    }
  }, [form.watch("zone"), zones]);

  // Update the area name when area changes
  useEffect(() => {
    const area = form.getValues("area");
    if (area) {
      // Set the area name in the form
      const selectedArea = areas.find((a) => a.id === area);
      if (selectedArea) {
        form.setValue("areaName", selectedArea.name);
        console.log("Set areaName to", selectedArea.name);
      }
    } else {
      form.setValue("areaName", "");
    }
  }, [form.watch("area"), areas]);

  // Check for value updates that might come from outside
  useEffect(() => {
    // This effect runs on every render to check if the values changed from outside
    const currentCity = form.getValues("city");
    const currentZone = form.getValues("zone");
    const currentArea = form.getValues("area");

    console.log("LocationSelector checking values:", {
      currentCity,
      currentZone,
      currentArea,
    });

    // If we have city and cities are loaded but the city isn't in the currently selected dropdown
    if (
      currentCity &&
      cities.length > 0 &&
      !cities.some((c) => c.id === currentCity)
    ) {
      console.log("City value present but not in dropdown, loading zones");
      loadZones(currentCity);
    }

    // If we have zone and zones are loaded but the zone isn't in the currently selected dropdown
    if (
      currentZone &&
      zones.length > 0 &&
      !zones.some((z) => z.id === currentZone)
    ) {
      console.log("Zone value present but not in dropdown, loading areas");
      loadAreas(currentZone);
    }
  }, []);


  const loadZones = async (cityId: string) => {
    try {
      setLoadingZones(true);
      const response = await fetch(
        `/api/settings/delivery-locations?type=zone&parentId=${cityId}`,
      );

      if (!response.ok) {
        throw new Error("Failed to load zones");
      }

      const result = await response.json();
      setZones(result.data);
    } catch (error) {
      console.error("Error loading zones:", error);
    } finally {
      setLoadingZones(false);
    }
  };

  const loadAreas = async (zoneId: string) => {
    try {
      setLoadingAreas(true);
      const response = await fetch(
        `/api/settings/delivery-locations?type=area&parentId=${zoneId}`,
      );

      if (!response.ok) {
        throw new Error("Failed to load areas");
      }

      const result = await response.json();
      setAreas(result.data);
    } catch (error) {
      console.error("Error loading areas:", error);
    } finally {
      setLoadingAreas(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <FormField
        control={form.control}
        name="city"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              City<span className="text-red-500">*</span>
            </FormLabel>
            <Select
              value={field.value || "_none"}
              onValueChange={(value) => {
                const cityId = value === "_none" ? "" : value;
                field.onChange(cityId);

                // Set the city name immediately
                if (cityId) {
                  const selectedCity = cities.find((c) => c.id === cityId);
                  if (selectedCity) {
                    form.setValue("cityName", selectedCity.name);
                    console.log(
                      "✅ Direct cityName set on change:",
                      selectedCity.name,
                    );
                  }
                } else {
                  form.setValue("cityName", "");
                }
              }}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select a city">
                    {loadingCities ? (
                      <div className="flex items-center">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </div>
                    ) : field.value ? (
                      cities.find((c) => c.id === field.value)?.name ||
                      form.getValues("cityName") ||
                      field.value
                    ) : (
                      "Select a city"
                    )}
                  </SelectValue>
                </SelectTrigger>
              </FormControl>
              <SelectContent className="rounded-xl bg-background">
                <SelectItem value="_none">-- Select a city --</SelectItem>
                {cities.map((city) => (
                  <SelectItem key={city.id} value={city.id}>
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
            <FormLabel>
              Zone<span className="text-red-500">*</span>
            </FormLabel>
            <Select
              value={field.value || "_none"}
              onValueChange={(value) => {
                const zoneId = value === "_none" ? "" : value;
                field.onChange(zoneId);

                // Set the zone name immediately
                if (zoneId) {
                  const selectedZone = zones.find((z) => z.id === zoneId);
                  if (selectedZone) {
                    form.setValue("zoneName", selectedZone.name);
                    console.log(
                      "✅ Direct zoneName set on change:",
                      selectedZone.name,
                    );
                  }
                } else {
                  form.setValue("zoneName", "");
                }
              }}
              disabled={!form.getValues("city") || loadingZones}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select a zone">
                    {loadingZones ? (
                      <div className="flex items-center">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </div>
                    ) : field.value ? (
                      zones.find((z) => z.id === field.value)?.name ||
                      form.getValues("zoneName") ||
                      field.value
                    ) : (
                      "Select a zone"
                    )}
                  </SelectValue>
                </SelectTrigger>
              </FormControl>
              <SelectContent className="rounded-xl bg-background">
                <SelectItem value="_none">-- Select a zone --</SelectItem>
                {zones.map((zone) => (
                  <SelectItem key={zone.id} value={zone.id}>
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
            <FormLabel>Area (Optional)</FormLabel>
            <Select
              value={field.value || "_none"}
              onValueChange={(value) => {
                const areaId = value === "_none" ? "" : value;
                field.onChange(areaId);

                // Set the area name immediately
                if (areaId) {
                  const selectedArea = areas.find((a) => a.id === areaId);
                  if (selectedArea) {
                    form.setValue("areaName", selectedArea.name);
                    console.log(
                      "✅ Direct areaName set on change:",
                      selectedArea.name,
                    );
                  }
                } else {
                  form.setValue("areaName", "");
                }
              }}
              disabled={!form.getValues("zone") || loadingAreas}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select an area">
                    {loadingAreas ? (
                      <div className="flex items-center">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </div>
                    ) : field.value ? (
                      areas.find((a) => a.id === field.value)?.name ||
                      form.getValues("areaName") ||
                      field.value
                    ) : (
                      "Select an area"
                    )}
                  </SelectValue>
                </SelectTrigger>
              </FormControl>
              <SelectContent className="rounded-xl bg-background">
                <SelectItem value="_none">-- No area selected --</SelectItem>
                {areas.map((area) => (
                  <SelectItem key={area.id} value={area.id}>
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
