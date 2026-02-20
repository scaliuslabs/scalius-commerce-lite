import type { DeliveryProvider, DeliveryShipment } from "@/db/schema";

export interface OrderItem {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
  productName: string | null;
  productImage: string | null;
  variantSize: string | null;
  variantColor: string | null;
}

export interface Order {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  city: string;
  zone: string;
  area: string | null;
  notes: string | null;
  discountAmount: number | null;
  shippingCharge: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  items: OrderItem[];
  totalAmount: number;
  customerId: string | null;
  cityName?: string;
  zoneName?: string;
  areaName?: string | null;
  shipments?: DeliveryShipment[];
  deliveryProviders?: DeliveryProvider[];
  // Payment fields
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  paidAmount?: number | null;
  balanceDue?: number | null;
  fulfillmentStatus?: string | null;
  inventoryPool?: string | null;
}

// This will be useful for the status constants
export const ORDER_STATUSES = [
  "pending",
  "processing",
  "confirmed",
  "shipped",
  "delivered",
  "completed",
  "cancelled",
  "returned",
] as const;
