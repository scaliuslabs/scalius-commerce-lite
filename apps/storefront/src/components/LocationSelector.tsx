import { useCallback, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import CustomDropdown from "@/components/CustomDropdown";
import SimpleDropdown from "@/components/SimpleDropdown";
import { getZones, getAreas, type LocationData } from "@/lib/api";
import {
  resolveLocationOption,
  type LocationPrefillDetail,
} from "./location-selector-utils";

// Use the LocationData type directly from api-client
interface LocationSelectorProps {
  cities: LocationData[];
  cityLabel?: string;
  zoneLabel?: string;
  areaLabel?: string;
  showAreaField?: boolean;
}

export default function LocationSelector({
  cities,
  cityLabel = "City",
  zoneLabel = "Zone",
  areaLabel = "Area (Optional)",
  showAreaField = true,
}: LocationSelectorProps) {
  const [selectedCity, setSelectedCity] = useState<string>("");
  const [selectedZone, setSelectedZone] = useState<string>("");
  const [selectedArea, setSelectedArea] = useState<string>("");
  const [zones, setZones] = useState<LocationData[]>([]);
  const [areas, setAreas] = useState<LocationData[]>([]);
  const [isLoadingZones, setIsLoadingZones] = useState<boolean>(false);
  const [isLoadingAreas, setIsLoadingAreas] = useState<boolean>(false);

  const loadZones = useCallback(async (cityId: string): Promise<LocationData[]> => {
    if (!cityId) return [];
    setIsLoadingZones(true);
    try {
      const response = await getZones(cityId);
      const nextZones = response || [];
      setZones(nextZones);
      return nextZones;
    } catch (error: unknown) {
      console.error("Error loading zones:", error);
      setZones([]);
      return [];
    } finally {
      setIsLoadingZones(false);
    }
  }, []);

  const loadAreas = useCallback(async (zoneId: string): Promise<LocationData[]> => {
    if (!zoneId) return [];
    setIsLoadingAreas(true);
    try {
      const response = await getAreas(zoneId);
      const nextAreas = response || [];
      setAreas(nextAreas);
      return nextAreas;
    } catch (error: unknown) {
      console.error("Error loading areas:", error);
      setAreas([]);
      return [];
    } finally {
      setIsLoadingAreas(false);
    }
  }, []);

  const dispatchZoneSelected = useCallback(
    (zoneId: string, sourceZones = zones) => {
      const selectedZoneData = sourceZones.find((z) => z.id === zoneId);
      const event = new CustomEvent("zone-selected", {
        detail: {
          zoneId,
          zoneName: selectedZoneData?.name || "",
        },
      });
      window.dispatchEvent(event);
    },
    [zones],
  );

  const prefillLocation = useCallback(
    async (detail: LocationPrefillDetail) => {
      const city = resolveLocationOption(cities, detail.city, detail.cityName);
      if (!city) return;

      setSelectedCity(city.id);
      setSelectedZone("");
      setSelectedArea("");
      setZones([]);
      setAreas([]);

      const nextZones = await loadZones(city.id);
      const zone = resolveLocationOption(nextZones, detail.zone, detail.zoneName);
      if (!zone) return;

      setSelectedZone(zone.id);
      dispatchZoneSelected(zone.id, nextZones);

      const nextAreas = await loadAreas(zone.id);
      const area = resolveLocationOption(nextAreas, detail.area, detail.areaName);
      if (area) {
        setSelectedArea(area.id);
      }
    },
    [cities, dispatchZoneSelected, loadAreas, loadZones],
  );

  useEffect(() => {
    const handlePrefill = (event: Event) => {
      void prefillLocation((event as CustomEvent<LocationPrefillDetail>).detail || {});
    };

    window.addEventListener("location-prefill", handlePrefill);
    return () => window.removeEventListener("location-prefill", handlePrefill);
  }, [prefillLocation]);

  const handleCityChange = (value: string) => {
    setSelectedCity(value);
    setSelectedZone("");
    setSelectedArea("");
    setZones([]);
    setAreas([]);
    void loadZones(value);
  };

  const handleZoneChange = (value: string) => {
    setSelectedZone(value);
    setSelectedArea("");
    setAreas([]);
    if (value) {
      void loadAreas(value);
      dispatchZoneSelected(value);
    }
  };

  const handleAreaChange = (value: string) => {
    setSelectedArea(value);
  };

  // Convert data to dropdown options format
  const cityOptions = cities.map((city) => ({
    value: city.id,
    label: city.name,
  }));

  const zoneOptions = zones.map((zone) => ({
    value: zone.id,
    label: zone.name,
  }));

  const areaOptions = areas.map((area) => ({
    value: area.id,
    label: area.name,
  }));

  return (
    <div className="space-y-2.5">
      <div className="relative">
        <Label
          htmlFor="city"
          className="mb-1 block text-xs font-semibold text-gray-700 uppercase tracking-wide"
        >
          {cityLabel} <span className="text-red-500 ml-0.5">*</span>
        </Label>
        <CustomDropdown
          id="city"
          name="city"
          placeholder="Select a city"
          options={cityOptions}
          value={selectedCity}
          onChange={handleCityChange}
          required
          className="bg-gray-50 border-gray-200 rounded-lg h-9"
          triggerClassName="bg-gray-50 border-gray-200 rounded-lg h-9"
        />
      </div>

      <div className="relative">
        <Label
          htmlFor="zone"
          className="mb-1 block text-xs font-semibold text-gray-700 uppercase tracking-wide"
        >
          {zoneLabel} <span className="text-red-500 ml-0.5">*</span>
        </Label>
        <CustomDropdown
          id="zone"
          name="zone"
          placeholder="Select a zone"
          options={zoneOptions}
          value={selectedZone}
          onChange={handleZoneChange}
          disabled={!selectedCity || isLoadingZones}
          required
          className="bg-gray-50 border-gray-200 rounded-lg h-9"
          triggerClassName="bg-gray-50 border-gray-200 rounded-lg h-9"
        />
        {isLoadingZones && (
          <div className="absolute right-3 top-[calc(50%+4px)] -translate-y-1/2 h-4 w-4 animate-spin rounded-full border-2 border-solid border-gray-400 border-r-transparent">
            <span className="sr-only">Loading...</span>
          </div>
        )}
      </div>

      {showAreaField && (
        <div className="relative">
          <Label
            htmlFor="area"
            className="mb-1 block text-xs font-semibold text-gray-700 uppercase tracking-wide"
          >
            {areaLabel}
          </Label>
          <SimpleDropdown
            id="area"
            name="area"
            placeholder="Select an area (optional)"
            options={areaOptions}
            value={selectedArea}
            onChange={handleAreaChange}
            disabled={!selectedZone || isLoadingAreas}
            className="bg-gray-50 border-gray-200 rounded-lg h-9 z-10"
            triggerClassName="bg-gray-50 border-gray-200 rounded-lg h-9"
          />
          {isLoadingAreas && (
            <div className="absolute right-3 top-[calc(50%+4px)] -translate-y-1/2 h-4 w-4 animate-spin rounded-full border-2 border-solid border-gray-400 border-r-transparent">
              <span className="sr-only">Loading...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
