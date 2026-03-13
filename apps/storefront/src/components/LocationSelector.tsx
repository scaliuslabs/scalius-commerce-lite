import { useState } from "react";
import { Label } from "@/components/ui/label";
import CustomDropdown from "@/components/CustomDropdown";
import SimpleDropdown from "@/components/SimpleDropdown";
import { getZones, getAreas, type LocationData } from "@/lib/api";

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

  const loadZones = async (cityId: string) => {
    if (!cityId) return;
    setIsLoadingZones(true);
    try {
      const response = await getZones(cityId);
      if (response) {
        setZones(response);
      } else {
        setZones([]);
      }
    } catch (error) {
      console.error("Error loading zones:", error);
      setZones([]);
    } finally {
      setIsLoadingZones(false);
    }
  };

  const loadAreas = async (zoneId: string) => {
    if (!zoneId) return;
    setIsLoadingAreas(true);
    try {
      const response = await getAreas(zoneId);
      if (response) {
        setAreas(response);
      } else {
        setAreas([]);
      }
    } catch (error) {
      console.error("Error loading areas:", error);
      setAreas([]);
    } finally {
      setIsLoadingAreas(false);
    }
  };

  const handleCityChange = (value: string) => {
    setSelectedCity(value);
    setSelectedZone("");
    setSelectedArea("");
    setZones([]);
    setAreas([]);
    loadZones(value);
  };

  const handleZoneChange = (value: string) => {
    setSelectedZone(value);
    setSelectedArea("");
    setAreas([]);
    if (value) {
      loadAreas(value);
      // Dispatch a custom event when the zone is selected
      const selectedZoneData = zones.find((z) => z.id === value);
      const event = new CustomEvent("zone-selected", {
        detail: {
          zoneId: value,
          zoneName: selectedZoneData?.name || "",
        },
      });
      window.dispatchEvent(event);
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
