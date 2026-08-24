import { useCallback, useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import CustomDropdown from "@/components/CustomDropdown";
import { getZones, getAreas, type LocationData } from "@/lib/api";
import {
  resolveLocationOption,
  type LocationPrefillDetail,
} from "./location-selector-utils";
import { readCheckoutFormDraft } from "@/lib/checkout/session-state";

// Use the LocationData type directly from api-client
interface LocationSelectorProps {
  cities: LocationData[];
  cityLabel?: string;
  zoneLabel?: string;
  areaLabel?: string;
  showAreaField?: boolean;
  onSelectionChange?: (selection: LocationSelection) => void;
}

export interface LocationSelection {
  cityId: string;
  cityName: string;
  zoneId: string;
  zoneName: string;
  areaId: string;
  areaName: string;
}

export default function LocationSelector({
  cities,
  cityLabel = "City",
  zoneLabel = "Zone",
  areaLabel = "Area (Optional)",
  showAreaField = true,
  onSelectionChange,
}: LocationSelectorProps) {
  const [selectedCity, setSelectedCity] = useState<string>("");
  const [selectedZone, setSelectedZone] = useState<string>("");
  const [selectedArea, setSelectedArea] = useState<string>("");
  const [zones, setZones] = useState<LocationData[]>([]);
  const [areas, setAreas] = useState<LocationData[]>([]);
  const [isLoadingZones, setIsLoadingZones] = useState<boolean>(false);
  const [isLoadingAreas, setIsLoadingAreas] = useState<boolean>(false);
  const [zoneLoadFailed, setZoneLoadFailed] = useState(false);
  const [areaLoadFailed, setAreaLoadFailed] = useState(false);
  const zoneRequestId = useRef(0);
  const areaRequestId = useRef(0);
  const onSelectionChangeRef = useRef(onSelectionChange);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  const loadZones = useCallback(
    async (cityId: string): Promise<LocationData[]> => {
      if (!cityId) return [];
      const requestId = ++zoneRequestId.current;
      setIsLoadingZones(true);
      setZoneLoadFailed(false);
      try {
        const response = await getZones(cityId);
        const nextZones = response || [];
        if (requestId === zoneRequestId.current) {
          setZones(nextZones);
          setZoneLoadFailed(response === null);
          return nextZones;
        }
        return [];
      } catch (error: unknown) {
        console.error("Error loading zones:", error);
        if (requestId === zoneRequestId.current) {
          setZones([]);
          setZoneLoadFailed(true);
        }
        return [];
      } finally {
        if (requestId === zoneRequestId.current) setIsLoadingZones(false);
      }
    },
    [],
  );

  const loadAreas = useCallback(
    async (zoneId: string): Promise<LocationData[]> => {
      if (!zoneId) return [];
      const requestId = ++areaRequestId.current;
      setIsLoadingAreas(true);
      setAreaLoadFailed(false);
      try {
        const response = await getAreas(zoneId);
        const nextAreas = response || [];
        if (requestId === areaRequestId.current) {
          setAreas(nextAreas);
          setAreaLoadFailed(response === null);
          return nextAreas;
        }
        return [];
      } catch (error: unknown) {
        console.error("Error loading areas:", error);
        if (requestId === areaRequestId.current) {
          setAreas([]);
          setAreaLoadFailed(true);
        }
        return [];
      } finally {
        if (requestId === areaRequestId.current) setIsLoadingAreas(false);
      }
    },
    [],
  );

  const dispatchZoneSelected = useCallback(
    (zoneId: string, sourceZones: LocationData[]) => {
      const selectedZoneData = sourceZones.find((z) => z.id === zoneId);
      const event = new CustomEvent("zone-selected", {
        detail: {
          zoneId,
          zoneName: selectedZoneData?.name || "",
        },
      });
      window.dispatchEvent(event);
    },
    [],
  );

  const notifySelection = useCallback(
    (selection: LocationSelection) => {
      onSelectionChangeRef.current?.(selection);
      window.dispatchEvent(
        new CustomEvent("checkout-location-change", { detail: selection }),
      );
    },
    [],
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
      notifySelection({
        cityId: city.id,
        cityName: city.name,
        zoneId: "",
        zoneName: "",
        areaId: "",
        areaName: "",
      });

      const nextZones = await loadZones(city.id);
      const zone = resolveLocationOption(
        nextZones,
        detail.zone,
        detail.zoneName,
      );
      if (!zone) return;

      setSelectedZone(zone.id);
      dispatchZoneSelected(zone.id, nextZones);

      const nextAreas = showAreaField ? await loadAreas(zone.id) : [];
      const area = resolveLocationOption(
        nextAreas,
        detail.area,
        detail.areaName,
      );
      const areaId = area?.id ?? "";
      if (areaId) {
        setSelectedArea(areaId);
      }
      notifySelection({
        cityId: city.id,
        cityName: city.name,
        zoneId: zone.id,
        zoneName: zone.name,
        areaId,
        areaName: area?.name ?? "",
      });
    },
    [
      cities,
      dispatchZoneSelected,
      loadAreas,
      loadZones,
      notifySelection,
      showAreaField,
    ],
  );

  useEffect(() => {
    const handlePrefill = (event: Event) => {
      void prefillLocation(
        (event as CustomEvent<LocationPrefillDetail>).detail || {},
      );
    };

    window.addEventListener("location-prefill", handlePrefill);
    const draft = readCheckoutFormDraft();
    if (draft?.city || draft?.cityName) {
      void prefillLocation({
        city: draft.city,
        cityName: draft.cityName,
        zone: draft.zone,
        zoneName: draft.zoneName,
        area: draft.area,
        areaName: draft.areaName,
      });
    }
    return () => window.removeEventListener("location-prefill", handlePrefill);
  }, [prefillLocation]);

  const handleCityChange = (value: string) => {
    const city = cities.find((item) => item.id === value);
    setSelectedCity(value);
    setSelectedZone("");
    setSelectedArea("");
    setZones([]);
    setAreas([]);
    setZoneLoadFailed(false);
    setAreaLoadFailed(false);
    areaRequestId.current += 1;
    notifySelection({
      cityId: value,
      cityName: city?.name || "",
      zoneId: "",
      zoneName: "",
      areaId: "",
      areaName: "",
    });
    void loadZones(value);
  };

  const handleZoneChange = (value: string) => {
    const city = cities.find((item) => item.id === selectedCity);
    const zone = zones.find((item) => item.id === value);
    setSelectedZone(value);
    setSelectedArea("");
    setAreas([]);
    notifySelection({
      cityId: selectedCity,
      cityName: city?.name || "",
      zoneId: value,
      zoneName: zone?.name || "",
      areaId: "",
      areaName: "",
    });
    if (value && showAreaField) {
      void loadAreas(value);
      dispatchZoneSelected(value, zones);
    } else if (value) {
      dispatchZoneSelected(value, zones);
    }
  };

  const handleAreaChange = (value: string) => {
    const city = cities.find((item) => item.id === selectedCity);
    const zone = zones.find((item) => item.id === selectedZone);
    const area = areas.find((item) => item.id === value);
    setSelectedArea(value);
    notifySelection({
      cityId: selectedCity,
      cityName: city?.name || "",
      zoneId: selectedZone,
      zoneName: zone?.name || "",
      areaId: value,
      areaName: area?.name || "",
    });
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
          id="city-label"
          className="mb-1 block text-sm font-medium text-foreground"
        >
          {cityLabel} <span className="text-red-500 ml-0.5">*</span>
        </Label>
        <CustomDropdown
          id="city"
          labelId="city-label"
          ariaLabel={cityLabel}
          name="city"
          placeholder="Select a city"
          options={cityOptions}
          value={selectedCity}
          onChange={handleCityChange}
          required
          className="bg-gray-50 border-gray-200 rounded-lg"
          triggerClassName="bg-gray-50 border-gray-200 rounded-lg"
        />
      </div>

      <div className="relative">
        <Label
          htmlFor="zone"
          id="zone-label"
          className="mb-1 block text-sm font-medium text-foreground"
        >
          {zoneLabel} <span className="text-red-500 ml-0.5">*</span>
        </Label>
        <CustomDropdown
          id="zone"
          labelId="zone-label"
          ariaLabel={zoneLabel}
          name="zone"
          placeholder="Select a zone"
          options={zoneOptions}
          value={selectedZone}
          onChange={handleZoneChange}
          disabled={!selectedCity || isLoadingZones}
          required
          className="bg-gray-50 border-gray-200 rounded-lg"
          triggerClassName="bg-gray-50 border-gray-200 rounded-lg"
        />
        {isLoadingZones && (
          <div className="absolute right-3 top-[calc(50%+4px)] -translate-y-1/2 h-4 w-4 animate-spin rounded-full border-2 border-solid border-gray-400 border-r-transparent">
            <span className="sr-only">Loading...</span>
          </div>
        )}
        {zoneLoadFailed && (
          <button
            type="button"
            className="mt-1 text-xs font-medium text-destructive underline underline-offset-2"
            onClick={() => void loadZones(selectedCity)}
          >
            Could not load zones. Try again
          </button>
        )}
      </div>

      {showAreaField && (
        <div className="relative">
          <Label
            htmlFor="area"
            id="area-label"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            {areaLabel}
          </Label>
          <CustomDropdown
            id="area"
            labelId="area-label"
            ariaLabel={areaLabel}
            name="area"
            placeholder="Select an area (optional)"
            options={areaOptions}
            value={selectedArea}
            onChange={handleAreaChange}
            disabled={!selectedZone || isLoadingAreas}
            className="z-10 rounded-lg border-gray-200 bg-gray-50"
            triggerClassName="rounded-lg border-gray-200 bg-gray-50"
          />
          {isLoadingAreas && (
            <div className="absolute right-3 top-[calc(50%+4px)] -translate-y-1/2 h-4 w-4 animate-spin rounded-full border-2 border-solid border-gray-400 border-r-transparent">
              <span className="sr-only">Loading...</span>
            </div>
          )}
          {areaLoadFailed && (
            <button
              type="button"
              className="mt-1 text-xs font-medium text-destructive underline underline-offset-2"
              onClick={() => void loadAreas(selectedZone)}
            >
              Could not load areas. Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
