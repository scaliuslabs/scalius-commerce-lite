// src/store/orderStore.ts
// Simple reactive store for order calculations (replaces nanostores)

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

type Listener = (calc: OrderCalculation) => void;

let currentItems: OrderItem[] = [];
let currentShipping = 0;
let currentDiscount: number | null = null;
const listeners: Set<Listener> = new Set();

function getCalculation(): OrderCalculation {
  const subtotal = currentItems.reduce(
    (sum: number, item: OrderItem) => sum + item.price * item.quantity,
    0,
  );
  const total = subtotal + currentShipping - (currentDiscount || 0);
  return {
    items: currentItems,
    shippingCharge: currentShipping,
    discountAmount: currentDiscount,
    subtotal,
    total,
  };
}

function notify() {
  const calc = getCalculation();
  listeners.forEach((cb) => cb(calc));
}

export function updateOrderItems(items: OrderItem[]) {
  currentItems = items;
  notify();
}

export function updateShippingCharge(amount: number) {
  currentShipping = amount;
  notify();
}

export function updateDiscountAmount(amount: number | null) {
  currentDiscount = amount;
  notify();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOrderCalculation(): OrderCalculation {
  return getCalculation();
}
