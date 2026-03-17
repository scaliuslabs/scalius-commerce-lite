import { z } from "zod";

export interface Product {
  id: string;
  name: string;
  price: number;
  discountPercentage: number | null;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  slug: string;
}

export const formSchema = z.object({
  code: z.string().min(1, "Discount code is required").max(50),
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
  minPurchaseAmount: z.number().nullable().optional(),
  minQuantity: z.number().int().positive().nullable().optional(),
  maxUsesPerOrder: z.number().int().positive().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  limitOnePerCustomer: z.boolean(),
  combineWithProductDiscounts: z.boolean(),
  combineWithOrderDiscounts: z.boolean(),
  combineWithShippingDiscounts: z.boolean(),
  startDate: z.date({ message: "Start date is required." }),
  endDate: z.date().nullable().optional(),
  isActive: z.boolean(),
});

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
