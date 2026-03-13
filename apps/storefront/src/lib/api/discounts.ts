// src/lib/api/discounts.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { CartItem } from "@/store/cart";
import type { DiscountValidationResponse } from "./types";

/**
 * Validates a discount code against the current cart state.
 *
 * @param code The discount code to validate.
 * @param total The current subtotal of the cart.
 * @param items The items currently in the cart.
 * @param shippingCost The calculated shipping cost.
 * @param customerPhone The customer's phone number, for per-customer usage checks.
 * @returns A promise resolving to the validation result.
 */
export async function validateDiscount(
  code: string,
  total?: number,
  items?: CartItem[],
  shippingCost?: number,
  customerPhone?: string,
): Promise<DiscountValidationResponse | null> {
  if (!code || !code.trim()) {
    console.error("validateDiscount: code is required.");
    return null;
  }
  try {
    const params = new URLSearchParams({ code });
    if (total !== undefined) params.append("total", String(total));
    if (shippingCost !== undefined) params.append("shippingCost", String(shippingCost));
    if (customerPhone) params.append("customerPhone", customerPhone);
    if (items && items.length > 0) {
      // Only send fields the API needs to keep URLs short and match cartItemSchema
      const apiItems = items.map((item: any) => ({
        id: item.id || item.productId,
        price: Number(item.price),
        quantity: Number(item.quantity),
        ...(item.variantId ? { variantId: item.variantId } : {}),
      }));
      params.append("items", JSON.stringify(apiItems));
    }
    
    const url = createApiUrl(`/discounts/validate?${params.toString()}`);
    // This is a public endpoint.
    const response = await fetchWithRetry(url, {}, 2, 8000, false);

    if (!response.ok) {
      // API returns specific error details in the body even for non-200 responses
      const errorData = await response.json();
      return errorData as DiscountValidationResponse;
    }

    return (await response.json()) as DiscountValidationResponse;
  } catch (error) {
    console.error(`Error validating discount code "${code}":`, error);
    return {
      valid: false,
      error: "An unexpected error occurred while validating the discount.",
    };
  }
}

/**
 * Records the usage of a discount for a specific order.
 * This should be called after an order is successfully created.
 *
 * @param discountId The ID of the discount that was used.
 * @param orderId The ID of the order where the discount was applied.
 * @param customerId The ID of the customer, if available.
 * @param amountDiscounted The final amount that was discounted from the order.
 * @returns A promise resolving to true on success, false on failure.
 */
export async function recordDiscountUsage(
  discountId: string,
  orderId: string,
  customerId: string | null,
  amountDiscounted: number,
): Promise<boolean> {
  try {
    const url = createApiUrl("/discounts/usage");
    const payload = {
      discountId,
      orderId,
      customerId,
      amountDiscounted,
    };
    
    // This is an authenticated, fire-and-forget style request.
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      2,
      8000,
      true
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to record discount usage:", errorText);
      return false;
    }
    
    console.log(`Successfully recorded usage for discount ${discountId} on order ${orderId}.`);
    return true;
  } catch (error) {
    console.error(`Error recording discount usage for discount ID "${discountId}":`, error);
    return false;
  }
}