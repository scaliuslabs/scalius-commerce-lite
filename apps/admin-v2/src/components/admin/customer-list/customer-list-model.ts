import type { Customer } from "~/types/api-responses";

/** Narrow bridge until the generated customer DTO includes this API field. */
export type CustomerListBuyer = Customer & {
  accountClaimedAt?: Date | string | number | null;
};

export function customerHasAccount(customer: CustomerListBuyer): boolean {
  return customer.accountClaimedAt != null;
}

export function formatCustomerLocation(customer: CustomerListBuyer): string {
  return [
    customer.address,
    customer.areaName,
    customer.zoneName,
    customer.cityName,
  ].filter(Boolean).join(", ");
}
