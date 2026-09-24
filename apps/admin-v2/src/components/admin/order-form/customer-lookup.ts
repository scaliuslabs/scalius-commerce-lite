import { toE164Phone } from "./types";

export interface SavedCustomer {
  name: string;
  email: string | null;
  phone: string;
  address: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  totalOrders: number;
}

export interface CustomerFormFields {
  customerName: string;
  customerEmail: string | null;
  shippingAddress: string;
  city: string;
  zone: string;
  area: string | null;
}

/**
 * The search text for a typed phone once it is a complete number
 * (01XXXXXXXXX for a Bangladesh mobile), or null while it is still partial.
 */
export function customerLookupTerm(rawPhone: string): string | null {
  const e164 = toE164Phone(rawPhone);
  if (!e164) return null;
  return e164.startsWith("+880") ? `0${e164.slice(4)}` : e164.replace(/^\+/, "");
}

/** The saved customer with exactly this phone number, if any. */
export function findCustomerByPhone<T extends SavedCustomer>(
  customers: readonly T[],
  rawPhone: string,
): T | null {
  const e164 = toE164Phone(rawPhone);
  if (!e164) return null;
  return customers.find((customer) => toE164Phone(customer.phone) === e164) ?? null;
}

/**
 * Values to fill from a returning customer: only fields the merchant left
 * empty, and the saved address only when no city was picked yet and the
 * saved city is still a delivery city.
 */
export function customerFill(
  customer: SavedCustomer,
  current: CustomerFormFields,
  knownCityIds: ReadonlySet<string>,
): Partial<CustomerFormFields> {
  const fill: Partial<CustomerFormFields> = {};
  if (!current.customerName.trim() && customer.name.trim()) fill.customerName = customer.name.trim();
  if (!current.customerEmail && customer.email) fill.customerEmail = customer.email;
  if (!current.shippingAddress.trim() && customer.address?.trim()) {
    fill.shippingAddress = customer.address.trim();
  }
  if (!current.city && customer.city && knownCityIds.has(customer.city)) {
    fill.city = customer.city;
    if (customer.zone) {
      fill.zone = customer.zone;
      fill.area = customer.area || null;
    }
  }
  return fill;
}
