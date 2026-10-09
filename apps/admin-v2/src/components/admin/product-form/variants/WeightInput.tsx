// A SKU's weight in the store's unit (Settings → Store details → Store
// defaults). The draft keeps grams, as `product_variants.weight` stores them;
// only this field converts, so validation and saving never see another unit.
import { forwardRef, type ComponentProps } from "react";
import type { WeightUnit } from "@scalius/shared/store-defaults";
import { gramsToWeightUnit, weightUnitToGrams } from "@scalius/shared/weight-units";
import { NumberInput } from "~/components/ui/number-input";
import { useStoreUnits } from "~/lib/api-query-options/store-defaults";

type WeightInputProps = Omit<ComponentProps<typeof NumberInput>, "value" | "onValueChange" | "integer" | "wholeUnitsMessage"> & {
  /** Grams, or null for no weight. */
  grams: number | null | undefined;
  onGramsChange: (grams: number | null) => void;
};

export const WeightInput = forwardRef<HTMLInputElement, WeightInputProps>(({ grams, onGramsChange, ...props }, ref) => {
  const { weightUnit } = useStoreUnits();
  return (
    <NumberInput
      ref={ref}
      {...props}
      suffix={weightUnit}
      value={grams === null || grams === undefined || Number.isNaN(grams) ? grams : gramsToWeightUnit(grams, weightUnit)}
      // Text that isn't a number stays NaN, so the form still refuses it.
      onValueChange={(value) => onGramsChange(value !== null && Number.isNaN(value) ? Number.NaN : weightUnitToGrams(value, weightUnit))}
    />
  );
});
WeightInput.displayName = "WeightInput";

/** The store's weight unit, for the field's label ("Weight (kg)"). */
export function useWeightUnit(): WeightUnit {
  return useStoreUnits().weightUnit;
}
