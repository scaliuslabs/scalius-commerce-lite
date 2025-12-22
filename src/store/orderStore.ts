//src/store/orderStore.ts
import { atom, map } from "nanostores";


export interface OrderItem {
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
}

export interface OrderCalculation {
  items: OrderItem[];
  shippingCharge: number;
  discountAmount: number | null;
  subtotal: number;
  total: number;
}

// Create atoms for individual values
export const orderItems = atom<OrderItem[]>([]);
export const shippingCharge = atom<number>(0);
export const discountAmount = atom<number | null>(null);

// Create a computed store for calculations
export const orderCalculations = map<OrderCalculation>({
  items: [],
  shippingCharge: 0,
  discountAmount: null,
  subtotal: 0,
  total: 0,
});

// Helper functions to update the store
export function updateOrderItems(items: OrderItem[]) {
  orderItems.set(items);
  updateCalculations();
}

export function updateShippingCharge(amount: number) {
  shippingCharge.set(amount);
  updateCalculations();
}

export function updateDiscountAmount(amount: number | null) {
  discountAmount.set(amount);
  updateCalculations();
}

// Function to update all calculations
function updateCalculations() {
  const items = orderItems.get();
  const shipping = shippingCharge.get();
  const discount = discountAmount.get();

  const subtotal = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const total = subtotal + shipping - (discount || 0);

  orderCalculations.set({
    items,
    shippingCharge: shipping,
    discountAmount: discount,
    subtotal,
    total,
  });
}
