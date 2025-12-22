export interface Product {
    id: string;
    name: string;
    price: number;
    discountPercentage: number | null;
    variants: {
      id: string;
      size: string | null;
      color: string | null;
      weight: number | null;
      sku: string;
      price: number;
      stock: number;
    }[];
  }
  
  export interface DeliveryLocation {
    id: string;
    name: string;
    type: "city" | "zone" | "area";
    parentId: string | null;
    externalIds: Record<string, any>;
    metadata: Record<string, any>;
    isActive: boolean;
    sortOrder: number;
  }
  
  export interface OrderItem {
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
  }
  
  // This will be useful for the new, refactored OrderForm props
  export interface OrderFormProps {
    products: Product[];
    defaultValues?: Partial<z.infer<typeof orderFormSchema>>;
    isEdit?: boolean;
  }
  
  // We need to import z and define the schema here to use it in OrderFormProps
  // This avoids circular dependencies later.
  import { z } from "zod";
  
  export const phoneNumberSchema = z
    .string()
    .min(11, "Phone number must be at least 11 characters")
    .max(14, "Phone number must be less than 14 characters");
  
  export const orderFormSchema = z.object({
    id: z.string().optional(),
    customerName: z
      .string()
      .min(3, "Customer name must be at least 3 characters")
      .max(100, "Customer name must be less than 100 characters"),
    customerPhone: phoneNumberSchema,
    customerEmail: z.string().email().nullable(),
    shippingAddress: z
      .string()
      .min(10, "Address must be at least 10 characters")
      .max(500, "Address must be less than 500 characters"),
    city: z.string().min(1, "City is required"),
    zone: z.string().min(1, "Zone is required"),
    area: z.string().nullable(),
    cityName: z.string().optional(),
    zoneName: z.string().optional(),
    areaName: z.string().nullable().optional(),
    notes: z
      .string()
      .max(500, "Notes must be less than 500 characters")
      .nullable(),
    items: z.array(
      z.object({
        productId: z.string().min(1, "Product is required"),
        variantId: z.string().nullable(),
        quantity: z.number().min(1, "Quantity must be at least 1"),
        price: z.number().min(0, "Price must be greater than or equal to 0"),
      }),
    ),
    discountAmount: z.coerce
      .number()
      .min(0, "Discount must be greater than or equal to 0")
      .nullable(),
    shippingCharge: z.coerce
      .number()
      .min(0, "Shipping charge must be greater than or equal to 0"),
    status: z.string().min(1, "Status is required").optional(),
  });
  
  export type OrderFormValues = z.infer<typeof orderFormSchema>;