// src/lib/api/discounts.ts

import { getConfiguredSdkClient } from "./client";
import type { CartItem } from "@/store/cart";
import type { DiscountValidationResponse } from "./types";
import { unwrapData } from "./unwrap";
import { getApiV1DiscountsValidate } from "@scalius/api-client/sdk";
import type { GetApiV1DiscountsValidateData } from "@scalius/api-client/types";

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
    const queryParams: GetApiV1DiscountsValidateData["query"] = { code };
    if (total !== undefined) queryParams.total = total;
    if (shippingCost !== undefined) queryParams.shippingCost = shippingCost;
    if (customerPhone) queryParams.customerPhone = customerPhone;
    if (items && items.length > 0) {
      const apiItems = items.map((item) => {
        const legacyProductId =
          "productId" in item && typeof item.productId === "string"
            ? item.productId
            : undefined;
        return {
        id: item.id || legacyProductId,
        price: Number(item.price),
        quantity: Number(item.quantity),
        ...(item.variantId ? { variantId: item.variantId } : {}),
        };
      });
      queryParams.items = JSON.stringify(apiItems);
    }

    const { data, error } = await getApiV1DiscountsValidate({
      client: getConfiguredSdkClient(),
      query: queryParams,
    });

    if (error) {
      // API returns specific error details in the body even for non-200 responses
      return error as unknown as DiscountValidationResponse;
    }

    return unwrapData<DiscountValidationResponse>(data);
  } catch (error: unknown) {
    console.error(`Error validating discount code "${code}":`, error);
    return {
      valid: false,
      error: "An unexpected error occurred while validating the discount.",
    };
  }
}
