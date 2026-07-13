import type { CustomersListPayload } from "~/lib/api-functions/customers";

/** Customer row derived from the generated admin list contract. */
export type CustomerListBuyer = CustomersListPayload["customers"][number];

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
