// src/lib/cart/server.ts

import { MAX_LINE_QUANTITY } from "@scalius/shared/order-limits";
import {
  createOrder,
  type CreateOrderPayload,
  deleteAbandonedCheckout,
} from "@/lib/api";
import {
  validateCartItems as validateCartItemsWithApi,
  type CartRuleError,
  type CartValidationIssue,
} from "@/lib/api/orders";
import { CART_RULES_REASON } from "@/lib/checkout/tax-quote-error-contract";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { isLocationCountry, readForeignAddressFields, shippingCountryOf } from "@/lib/checkout/shipping-country";
import { readDiscountCodes } from "@/lib/checkout/tax-quote-client";
import { BILLING_ADDRESS_FIELDS, checkoutBillingFields } from "@/lib/checkout/billing-address";
import { marketingConsentOrderField } from "@/lib/checkout/marketing-consent";
import { parseCheckoutAttributes, parseRequestProperties } from "@/lib/checkout/tax-quote-contract";
import { cartLinePurchaseOptionId } from "./purchase-option";
import {
  checkoutAddressForMode,
  missingCheckoutFields,
  resolveCheckoutDeliveryMode,
} from "@/lib/checkout/delivery-mode";
import {
  cartItemVariantLabel,
  normalizeCartItemOptions,
  type CartItemOption,
} from "./item-options";

type ProcessOrderOptions = {
  customerSessionToken?: string | null;
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Settings → Checkout: every order asks for a full billing address. */
  requireFullBillingAddress?: boolean;
};

/**
 * Validates a parsed cart item has the required shape and safe value ranges.
 * Rejects items with missing/malformed fields to prevent price manipulation
 * or injection via crafted form data.
 */
interface ValidatedCartItem {
  cartKey: string;
  id: string;
  slug?: string;
  name: string;
  price: number;
  quantity: number;
  image?: string;
  variantId: string;
  options?: CartItemOption[];
  freeDelivery?: boolean;
  /** Buyer inputs (`{key, value}`), sent in the body to be validated and priced by the API. */
  properties?: Array<{ key: string; value: string }>;
  /** An app's purchase option for the line (`<app id>.<key>`). */
  purchaseOption?: string;
}

function parseCartItems(raw: unknown): ValidatedCartItem[] {
  if (raw === null || typeof raw !== "object") {
    throw new Error("Cart data must be a non-null object.");
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("Cart is empty.");
  }

  return entries.map(([cartKey, entry], idx) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`Cart item at index ${idx} is not an object.`);
    }

    const item = entry as Record<string, unknown>;

    // Required string fields
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new Error(`Cart item at index ${idx} has an invalid or missing id.`);
    }
    if (typeof item.name !== "string" || item.name.length === 0) {
      throw new Error(`Cart item at index ${idx} has an invalid or missing name.`);
    }
    if (
      typeof item.variantId !== "string" ||
      item.variantId.trim() === "" ||
      item.variantId.trim() === "default"
    ) {
      throw new Error(`Cart item "${item.name}" has an invalid or missing saved variant.`);
    }

    // Required numeric fields
    if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price < 0) {
      throw new Error(`Cart item "${item.name || idx}" has an invalid price.`);
    }
    if (
      typeof item.quantity !== "number" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > MAX_LINE_QUANTITY
    ) {
      throw new Error(
        `Cart item "${item.name || idx}" has an invalid quantity. Must be a whole number from 1 to ${MAX_LINE_QUANTITY}.`,
      );
    }

    // Optional string fields — must be strings if present
    const optionalStr = (key: string): string | undefined => {
      if (item[key] === undefined || item[key] === null || item[key] === "") return undefined;
      if (typeof item[key] !== "string") {
        throw new Error(`Cart item "${item.name}" has an invalid ${key} (expected string).`);
      }
      return item[key] as string;
    };

    let properties: ValidatedCartItem["properties"];
    try {
      properties = parseRequestProperties(
        Array.isArray(item.properties)
          ? item.properties.map((property) =>
              typeof property === "object" && property !== null
                ? { key: (property as { key?: unknown }).key, value: (property as { value?: unknown }).value }
                : property)
          : item.properties,
      );
    } catch {
      throw new Error(`Cart item "${item.name}" has invalid details.`);
    }
    // A cart line keeps `{ id, title }`; a malformed one is refused, never bought one-time.
    const purchaseOption = cartLinePurchaseOptionId(item.purchaseOption);
    if (item.purchaseOption !== undefined && item.purchaseOption !== null && !purchaseOption) {
      throw new Error(`Cart item "${item.name}" has invalid details.`);
    }

    return {
      cartKey,
      id: item.id as string,
      slug: optionalStr("slug"),
      name: item.name as string,
      price: item.price as number,
      quantity: item.quantity as number,
      image: optionalStr("image"),
      variantId: item.variantId.trim(),
      options: normalizeCartItemOptions(item.options),
      freeDelivery: typeof item.freeDelivery === "boolean" ? item.freeDelivery : undefined,
      ...(properties ? { properties } : {}),
      ...(purchaseOption ? { purchaseOption } : {}),
    };
  });
}

function displayVariantLabel(item: ValidatedCartItem): string | null {
  return cartItemVariantLabel(item.options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCartValidationIssue(value: unknown): value is CartValidationIssue {
  return (
    isRecord(value) &&
    typeof value.index === "number" &&
    typeof value.productId === "string" &&
    typeof value.message === "string"
  );
}

function itemIssuesFromDetails(details: unknown): CartValidationIssue[] | undefined {
  if (!isRecord(details) || !Array.isArray(details.itemIssues)) return undefined;
  const issues = details.itemIssues.filter(isCartValidationIssue);
  return issues.length > 0 ? issues : undefined;
}

function failedOrder(
  message: string,
  itemIssues?: CartValidationIssue[],
  ruleErrors?: CartRuleError[],
) {
  return {
    success: false,
    error: { message },
    ...(itemIssues && itemIssues.length > 0
      ? { details: { itemIssues } }
      : ruleErrors && ruleErrors.length > 0
        // The API's own refusal shape, so the cart says each rule where it belongs.
        ? { details: { reason: CART_RULES_REASON, ruleErrors } }
        : {}),
  };
}

/** Another country's region and postal code as posted, trimmed (empty ones left out). */
function readForeignDestination(formData: FormData): { shippingAdminArea?: string; shippingPostalCode?: string } {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const shippingAdminArea = text("shippingAdminArea");
  const shippingPostalCode = text("shippingPostalCode");
  return {
    ...(shippingAdminArea ? { shippingAdminArea } : {}),
    ...(shippingPostalCode ? { shippingPostalCode } : {}),
  };
}

export async function processOrder(
  formData: FormData,
  options: ProcessOrderOptions = {},
) {
  try {
    const customerName = formData.get("customerName") as string;
    const rawPhone = (formData.get("customerPhone") as string)?.trim();
    // Absent on a store that sells only to Bangladesh (no country field).
    const shippingCountryCode = shippingCountryOf(formData.get("shippingCountryCode"));
    const foreignAddress = !isLocationCountry(shippingCountryCode);
    let customerPhone: string;
    try {
      // A national number is read in the address country (Bangladesh as before).
      customerPhone = validateAndFormatPhone(rawPhone, undefined, { defaultCountry: shippingCountryCode });
    } catch {
      return {
        success: false,
        error: { message: "Please enter a valid phone number" },
      };
    }
    const customerEmail = (formData.get("customerEmail") as string) || null;
    // The optional WhatsApp number goes with the order as on the payment step.
    const customerWhatsapp = (formData.get("customerWhatsapp") as string | null)?.trim().slice(0, 32) || null;
    const shippingAddress = formData.get("shippingAddress") as string;
    const cityId = formData.get("city") as string;
    const zoneId = formData.get("zone") as string;
    const areaId = (formData.get("area") as string) || null;
    const notes = (formData.get("notes") as string) || null;
    const attributes = parseCheckoutAttributes(formData.get("attributes"));
    const cartItemsJson = formData.get("cartItems") as string;
    const shippingLocationId = formData.get("shippingLocation") as string;
    const shippingRateToken = typeof formData.get("shippingRateToken") === "string"
      ? String(formData.get("shippingRateToken"))
      : undefined;
    const discountCodes = readDiscountCodes({ discountCodes: formData.get("discountCodes") });
    const checkoutId = formData.get("checkoutId") as string | null;
    const checkoutRequestId = checkoutId?.trim();
    const expectedQuoteFingerprint = (
      formData.get("expectedQuoteFingerprint") as string | null
    )?.trim();

    if (!checkoutRequestId) {
      throw new Error("Checkout session expired. Please refresh checkout and try again.");
    }
    if (!expectedQuoteFingerprint) {
      throw new Error("Your order total is no longer verified. Refresh the checkout total and try again.");
    }

    const cartItems = JSON.parse(cartItemsJson);
    // Validate cart item shape and value ranges (defense against crafted form data)
    const cartItemsArray = parseCartItems(cartItems);

    // Phone and name are required on every path: this form places cash
    // orders only, and the shared contact rule (orderContactNeeds) always
    // needs a phone for them. The rest depends on the path below.
    if (!customerName || !customerPhone || cartItemsArray.length === 0) {
      throw new Error(
        "Please fill in all required fields and add items to your cart.",
      );
    }

    // The buyer's Delivery/Pickup choice only decides what is sent: the API
    // resolves the path from the SKUs and the chosen rate's kind.
    const chosenPath = formData.get("deliveryMode") === "pickup" ? "pickup" : "delivery";
    const cartValidation = await validateCartItemsWithApi(
      cartItemsArray.map((item) => ({
        cartKey: item.cartKey,
        productId: item.id,
        variantId: item.variantId,
        quantity: item.quantity,
        price: item.price,
        productName: item.name,
        variantLabel: displayVariantLabel(item),
        ...(item.properties ? { properties: item.properties } : {}),
        ...(item.purchaseOption ? { purchaseOption: item.purchaseOption } : {}),
      })),
      {
        ...(attributes ? { attributes } : {}),
        ...(shippingLocationId ? { shippingMethodId: shippingLocationId } : {}),
        ...(shippingRateToken ? { shippingRateToken } : {}),
        cod: true,
        ...(chosenPath === "delivery" && foreignAddress
          ? {
            shippingCountryCode,
            // Its shipping zone matches on the region and postal code (MARKETS-DESIGN step 3b).
            ...readForeignDestination(formData),
          }
          : chosenPath === "delivery" && cityId && zoneId
            ? { city: cityId, zone: zoneId, area: areaId }
            : {}),
      },
    );

    if (!cartValidation.success) {
      return failedOrder(
        cartValidation.error || "We couldn't check your cart. Try again.",
        itemIssuesFromDetails(cartValidation.details),
      );
    }
    if (!cartValidation.data.valid) {
      const firstIssue = cartValidation.data.issues[0];
      const ruleErrors = cartValidation.data.ruleErrors ?? [];
      return failedOrder(
        firstIssue?.message ||
          ruleErrors[0]?.message ||
          "Some items in your cart need attention before checkout.",
        cartValidation.data.issues,
        ruleErrors,
      );
    }
    const validated = cartValidation.data;
    const delivery = validated.delivery;
    // Nothing physical: no method, no fee, no address. Otherwise the rate's
    // own kind decides between delivery (address required) and pickup.
    const mode = resolveCheckoutDeliveryMode(
      validated.requiresDeliveryMethod !== false,
      delivery?.kind ?? chosenPath,
    );
    const missing = missingCheckoutFields(mode, {
      customerName,
      customerPhone,
      shippingAddress,
      city: cityId,
      zone: zoneId,
      shippingMethod: shippingLocationId,
    }, shippingCountryCode);
    if (missing.length > 0) {
      throw new Error("Please fill in all required fields and add items to your cart.");
    }
    if (mode !== "none" && !delivery) {
      throw new Error("Delivery information is no longer available. Please refresh checkout and try again.");
    }
    // This form places cash-on-delivery orders only; a cart that can't be
    // paid in cash (nothing handed over in person, or a delivery to a
    // country cash on delivery doesn't serve) is refused before commit.
    if (Array.isArray(validated.allowedPaymentMethods) && !validated.allowedPaymentMethods.includes("cod")) {
      throw new Error(mode === "delivery" && foreignAddress
        ? "Cash on delivery isn't available for this delivery country."
        : "This order can't be paid with cash on delivery.");
    }

    const inputsByCartKey = new Map(cartItemsArray.map((item) => [item.cartKey, item.properties]));
    const processedItems: CreateOrderPayload["items"] = validated.items.map((item) => {
      const properties = item.cartKey ? inputsByCartKey.get(item.cartKey) : undefined;
      // The option the server accepted on the line (it refuses one no app offers).
      const purchaseOption = item.purchaseOption?.id;
      return {
        cartKey: item.cartKey,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        price: item.unitPrice,
        productName: item.productName,
        variantLabel: item.variantLabel,
        ...(properties ? { properties } : {}),
        ...(purchaseOption ? { purchaseOption } : {}),
      };
    });
    const address = checkoutAddressForMode(mode, {
      ...(foreignAddress ? { shippingCountryCode, ...readForeignAddressFields((field) => formData.get(field)) } : {}),
      shippingAddress,
      city: cityId,
      zone: zoneId,
      area: areaId,
      cityName: delivery?.cityName,
      zoneName: delivery?.zoneName,
      areaName: delivery?.areaName,
    });
    // Only what checkout asked for (Shopify's rule): "same as shipping", or the billing address.
    const billing = checkoutBillingFields(mode, options.requireFullBillingAddress === true, {
      billingSameAsShipping: formData.get("billingSameAsShipping"),
      billingCountryCode: formData.get("billingCountryCode"),
      ...Object.fromEntries(BILLING_ADDRESS_FIELDS.map((field) => [field, formData.get(field)])),
    });
    const payload: CreateOrderPayload = {
      checkoutRequestId,
      expectedQuoteFingerprint,
      customerName,
      customerPhone,
      customerEmail,
      customerWhatsapp,
      ...address,
      ...billing,
      notes,
      ...(attributes ? { attributes } : {}),
      items: processedItems,
      shippingCharge: mode === "none" ? 0 : delivery?.shippingCharge ?? 0,
      shippingMethodId: mode === "none" ? null : shippingLocationId,
      ...(mode === "delivery" && shippingRateToken ? { shippingRateToken } : {}),
      discountCodes,
      paymentMethod: "cod",
      // Only when the buyer ticked the marketing consent box.
      ...marketingConsentOrderField(formData),
    };

    const result = await createOrder(payload, {
      customerSessionToken: options.customerSessionToken,
    });

    if (result.success && result.orderId) {
      if (checkoutId) {
        const cleanupTask = Promise.resolve(deleteAbandonedCheckout(checkoutId))
          .then(() => {
            console.log(`Successfully deleted abandoned checkout record: ${checkoutId}`);
          })
          .catch(() => {
            console.warn(
              `[Non-critical] Failed to delete abandoned checkout record ${checkoutId} after successful order.`,
            );
          });

        if (options.waitUntil) {
          options.waitUntil(cleanupTask);
        } else {
          void cleanupTask;
        }
      }
    }

    return result;
  } catch (error: unknown) {
    console.error("Order processing failed:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? { message: error.message }
          : { message: "An unexpected error occurred" },
    };
  }
}
