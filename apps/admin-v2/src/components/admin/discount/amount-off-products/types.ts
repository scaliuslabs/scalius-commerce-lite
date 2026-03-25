import { z } from "zod";
import { discountCodeSchema, sharedDiscountFields, refineEndDateAfterStart } from "../shared-validation";

export interface Product {
  id: string;
  name: string;
  price: number;
  discountPercentage?: number | null;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  type?: "manual" | "dynamic";
}

export const formSchema = refineEndDateAfterStart(
  z.object({
    code: discountCodeSchema,
    valueType: z.enum(["percentage", "fixed_amount"]),
    discountValue: z
      .number({ message: "Must be a number" })
      .positive("Value must be positive"),
    appliesTo: z
      .object({
        products: z.array(z.string()),
        collections: z.array(z.string()),
      })
      .refine((data) => data.products.length > 0 || data.collections.length > 0, {
        message: "Please select at least one product or collection.",
      }),
    ...sharedDiscountFields,
    minQuantity: z.coerce
      .number({ message: "Min quantity must be a number" })
      .int({ message: "Min quantity must be a whole number" })
      .positive({ message: "Min quantity must be positive" })
      .nullable()
      .optional(),
    combineWithProductDiscounts: z.boolean(),
    combineWithOrderDiscounts: z.boolean(),
    combineWithShippingDiscounts: z.boolean(),
  }),
);

export type FormValues = z.infer<typeof formSchema>;

export function handleOptionalNumberChange(
  e: React.ChangeEvent<HTMLInputElement>,
  onChange: (...event: unknown[]) => void,
  isInt = false,
) {
  const rawValue = e.target.value;
  if (rawValue === "") {
    onChange(null);
  } else {
    const value = isInt ? parseInt(rawValue, 10) : parseFloat(rawValue);
    if (!isNaN(value)) {
      onChange(value);
    } else if (!(rawValue === "-" || rawValue.endsWith("."))) {
      return;
    }
  }
}
