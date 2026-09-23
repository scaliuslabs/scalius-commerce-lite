// src/lib/api/discounts.ts

import { getConfiguredSdkClient } from "./transport";
import type { CartItem } from "@/store/cart";
import type { DiscountValidationResponse } from "./types";
import { unwrapData } from "./unwrap";
import { postApiV1DiscountsValidate } from "@scalius/api-client/sdk";
import { buildDiscountValidationBody } from "@/lib/cart/browser-api";

/**
 * Validates a discount code against the current cart state.
 *
 * @param code The discount code to validate.
 * @param items The items currently in the cart.
 * @param shippingCost The calculated shipping cost.
 * @param customerPhone The customer's phone number, for per-customer usage checks.
 * @returns A promise resolving to the validation result.
 */
export async function validateDiscount(
  code: string,
  items?: CartItem[],
  shippingCost?: number,
  customerPhone?: string,
): Promise<DiscountValidationResponse | null> {
  if (!code || !code.trim()) {
    console.error("validateDiscount: code is required.");
    return null;
  }
  try {
    const body = buildDiscountValidationBody(
      code,
      items,
      shippingCost,
      customerPhone,
    );

    const { data, error } = await postApiV1DiscountsValidate({
      client: getConfiguredSdkClient(),
      body,
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
