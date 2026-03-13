import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { ShippingMethod } from "@/lib/api";
import { getCurrencySymbol } from "@/lib/currency";

export interface ShippingLocationSelectorProps {
  shippingMethods: ShippingMethod[];
  shippingMethodLabel?: string;
}

export default function ShippingLocationSelector({
  shippingMethods,
  shippingMethodLabel = "Choose Delivery Option",
}: ShippingLocationSelectorProps) {
  const [selectedLocation, setSelectedLocation] = useState<string | undefined>(
    shippingMethods.length > 0 ? shippingMethods[0].id : undefined,
  );

  useEffect(() => {
    if (shippingMethods.length > 0 && !selectedLocation) {
      setSelectedLocation(shippingMethods[0].id);
    }
  }, [shippingMethods, selectedLocation]);

  useEffect(() => {
    if (selectedLocation) {
      const detail = {
        id: selectedLocation,
        fee:
          shippingMethods.find((sm) => sm.id === selectedLocation)?.fee || 0,
      };
      // Set directly on window to eliminate race condition with event listeners
      (window as any).lastShippingEventDetail = detail;
      const event = new CustomEvent("shippingLocationChange", { detail });
      window.dispatchEvent(event);
    }
  }, [selectedLocation, shippingMethods]);

  const handleLocationChange = (value: string) => {
    setSelectedLocation(value);
  };

  if (!shippingMethods || shippingMethods.length === 0) {
    return (
      <div>
        <Label className="mb-0.5 block text-xs sm:text-sm font-medium">
          {shippingMethodLabel}
        </Label>
        <p className="text-sm text-gray-500">
          No shipping methods available at this time.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Label className="mb-2 block text-xs font-semibold text-gray-700 uppercase tracking-wide">
        {shippingMethodLabel}
      </Label>
      <RadioGroup
        value={selectedLocation}
        onValueChange={handleLocationChange}
        className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        name="shippingLocation"
      >
        {shippingMethods.map((method) => (
          <Label
            key={method.id}
            htmlFor={method.id}
            className={`flex items-center justify-between rounded-lg border p-3 cursor-pointer transition-all duration-200 h-full ${
              selectedLocation === method.id
                ? "border-black bg-white ring-1 ring-black shadow-sm"
                : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
            }`}
          >
            <div className="flex items-center gap-3">
              <RadioGroupItem
                value={method.id}
                id={method.id}
                className="w-4 h-4 text-black border-gray-300 data-[state=checked]:border-black data-[state=checked]:text-black shrink-0"
              />
              <span className="font-medium text-xs sm:text-sm text-gray-900 leading-tight">
                {method.name}
              </span>
            </div>
            <span className="text-xs sm:text-sm font-bold text-gray-900 whitespace-nowrap ml-2">
              {getCurrencySymbol()}{method.fee.toLocaleString()}
            </span>
          </Label>
        ))}
      </RadioGroup>
    </div>
  );
}
