import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "@nanostores/react";
import { Label } from "@/components/ui/label";
import type { ShippingMethod } from "@/lib/api";
import { formatPriceShort } from "@/lib/currency";
import {
  cartHasFreeDeliveryItem,
  cartStore,
  getEffectiveCartShippingFee,
  hydrateCartFromStorage,
} from "@/store/cart";
import { readCheckoutFormDraft } from "@/lib/checkout/session-state";

export interface ShippingLocationSelectorProps {
  shippingMethods: ShippingMethod[];
  shippingMethodLabel?: string;
}

const subscribeToClientReadiness = () => () => {};
const getClientReadiness = () => true;
const getServerReadiness = () => false;

export default function ShippingLocationSelector({
  shippingMethods,
  shippingMethodLabel = "Choose Delivery Option",
}: ShippingLocationSelectorProps) {
  const storedCart = useStore(cartStore);
  const clientReady = useSyncExternalStore(
    subscribeToClientReadiness,
    getClientReadiness,
    getServerReadiness,
  );
  const visibleCartItems = clientReady ? storedCart.items : {};
  const shippingFeeIsWaived = cartHasFreeDeliveryItem(visibleCartItems);
  const [selectedLocation, setSelectedLocation] = useState<string | undefined>(
    shippingMethods.length > 0 ? shippingMethods[0].id : undefined,
  );
  const [draftRestoreReady, setDraftRestoreReady] = useState(false);

  useEffect(() => {
    hydrateCartFromStorage();
  }, []);

  useEffect(() => {
    const restore = (methodId: unknown) => {
      if (
        typeof methodId === "string" &&
        shippingMethods.some((method) => method.id === methodId)
      ) {
        setSelectedLocation(methodId);
      }
    };
    const handlePrefill = (event: Event) => {
      restore((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener("shipping-method-prefill", handlePrefill);
    restore(readCheckoutFormDraft()?.shippingLocation);
    setDraftRestoreReady(true);
    return () => window.removeEventListener("shipping-method-prefill", handlePrefill);
  }, [shippingMethods]);

  useEffect(() => {
    if (shippingMethods.length > 0 && !selectedLocation) {
      setSelectedLocation(shippingMethods[0].id);
    }
  }, [shippingMethods, selectedLocation]);

  useEffect(() => {
    if (draftRestoreReady && selectedLocation) {
      const selectedMethod = shippingMethods.find((sm) => sm.id === selectedLocation);
      const detail = {
        id: selectedLocation,
        fee: selectedMethod?.fee || 0,
        name: selectedMethod?.name || "",
      };
      // Set directly on window to eliminate race condition with event listeners
      window.lastShippingEventDetail = detail;
      const event = new CustomEvent("shippingLocationChange", { detail });
      window.dispatchEvent(event);
    }
  }, [draftRestoreReady, selectedLocation, shippingMethods]);

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

  if (shippingMethods.length === 1) {
    const method = shippingMethods[0];
    const effectiveFee = getEffectiveCartShippingFee(
      visibleCartItems,
      method.fee,
    );
    const feeLabel = effectiveFee === 0 ? "Free" : formatPriceShort(effectiveFee);

    return (
      <div>
        <Label className="mb-2 block text-sm font-medium text-foreground">
          {shippingMethodLabel}
        </Label>
        <input type="hidden" name="shippingLocation" value={method.id} />
        <div className="flex min-h-11 items-center justify-between rounded-lg border border-border bg-background px-3 py-2.5">
          <span className="text-sm font-medium text-foreground">{method.name}</span>
          <span className="ml-3 whitespace-nowrap text-sm font-semibold text-foreground">
            {feeLabel}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Label className="mb-2 block text-sm font-medium text-foreground">
        {shippingMethodLabel}
      </Label>
      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="sr-only">{shippingMethodLabel}</legend>
        {shippingMethods.map((method) => {
          const normalFeeLabel = formatPriceShort(method.fee);
          const effectiveFee = getEffectiveCartShippingFee(
            visibleCartItems,
            method.fee,
          );
          const feeLabel =
            effectiveFee === 0 ? "Free" : formatPriceShort(effectiveFee);
          const waivedFeeTitle =
            shippingFeeIsWaived && method.fee > 0
              ? `Normally ${normalFeeLabel}; waived by an item in your cart.`
              : undefined;

          return (
            <label
              key={method.id}
              className={`flex min-h-11 items-center justify-between rounded-lg border p-3 cursor-pointer transition-all duration-200 ${
                selectedLocation === method.id
                  ? "border-black bg-white ring-1 ring-black shadow-sm"
                  : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
              }`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="radio"
                  name="shippingLocation"
                  value={method.id}
                  checked={selectedLocation === method.id}
                  onChange={(event) => handleLocationChange(event.target.value)}
                  aria-label={`${method.name}, ${feeLabel}`}
                  className="h-4 w-4 shrink-0 accent-black"
                />
                <span className="font-medium text-xs sm:text-sm text-gray-900 leading-tight">
                  {method.name}
                </span>
              </div>
              <span
                className="text-xs sm:text-sm font-bold text-gray-900 whitespace-nowrap ml-2"
                title={waivedFeeTitle}
                aria-label={waivedFeeTitle}
              >
                {feeLabel}
              </span>
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}
