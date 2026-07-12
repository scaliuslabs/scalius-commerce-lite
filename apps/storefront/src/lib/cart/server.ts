// src/lib/cart/server.ts

import {
  createOrder,
  type CreateOrderPayload,
  getCities as getCitiesFromApi,
  validateDiscount,
  type LocationData,
  deleteAbandonedCheckout,
} from "@/lib/api";
import { validateCartItems as validateCartItemsWithApi, type CartValidationIssue } from "@/lib/api/orders";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import {
  cartItemVariantLabel,
  normalizeCartItemOptions,
  type CartItemOption,
} from "./item-options";

type ProcessOrderOptions = {
  customerSessionToken?: string | null;
  waitUntil?: (promise: Promise<unknown>) => void;
};

export async function getCities(): Promise<LocationData[]> {
  try {
    const citiesData = await getCitiesFromApi();
    return citiesData || [];
  } catch (error: unknown) {
    console.error("Failed to fetch cities from API via library:", error);
    return [];
  }
}

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
      item.quantity > 99
    ) {
      throw new Error(
        `Cart item "${item.name || idx}" has an invalid quantity. Must be an integer between 1 and 99.`,
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

function failedOrder(message: string, itemIssues?: CartValidationIssue[]) {
  return {
    success: false,
    error: { message },
    ...(itemIssues && itemIssues.length > 0
      ? { details: { itemIssues } }
      : {}),
  };
}

export async function processOrder(
  formData: FormData,
  options: ProcessOrderOptions = {},
) {
  try {
    const customerName = formData.get("customerName") as string;
    const rawPhone = (formData.get("customerPhone") as string)?.trim();
    let customerPhone: string;
    try {
      customerPhone = validateAndFormatPhone(rawPhone);
    } catch {
      return {
        success: false,
        error: { message: "Please enter a valid phone number" },
      };
    }
    const customerEmail = (formData.get("customerEmail") as string) || null;
    const shippingAddress = formData.get("shippingAddress") as string;
    const cityId = formData.get("city") as string;
    const zoneId = formData.get("zone") as string;
    const areaId = (formData.get("area") as string) || null;
    const notes = (formData.get("notes") as string) || null;
    const cartItemsJson = formData.get("cartItems") as string;
    const shippingLocationId = formData.get("shippingLocation") as string;
    const discountJson = formData.get("discountCodeHidden") as string;
    const checkoutId = formData.get("checkoutId") as string | null;
    const checkoutRequestId = checkoutId?.trim();

    if (!checkoutRequestId) {
      throw new Error("Checkout session expired. Please refresh checkout and try again.");
    }

    const cartItems = JSON.parse(cartItemsJson);
    // Validate cart item shape and value ranges (defense against crafted form data)
    const cartItemsArray = parseCartItems(cartItems);

    if (
      !customerName ||
      !customerPhone ||
      !shippingAddress ||
      !cityId ||
      !zoneId ||
      !shippingLocationId ||
      cartItemsArray.length === 0
    ) {
      throw new Error(
        "Please fill in all required fields and add items to your cart.",
      );
    }

    const cartValidation = await validateCartItemsWithApi(
      cartItemsArray.map((item) => ({
        cartKey: item.cartKey,
        productId: item.id,
        variantId: item.variantId,
        quantity: item.quantity,
        price: item.price,
        productName: item.name,
        variantLabel: displayVariantLabel(item),
      })),
      {
        city: cityId,
        zone: zoneId,
        area: areaId,
        shippingMethodId: shippingLocationId,
      },
    );

    if (!cartValidation.success) {
      return failedOrder(
        cartValidation.error || "Cart validation failed. Please refresh your cart and try again.",
        itemIssuesFromDetails(cartValidation.details),
      );
    }
    if (!cartValidation.data.valid) {
      const firstIssue = cartValidation.data.issues[0];
      return failedOrder(
        firstIssue?.message || "Some items in your cart need attention before checkout.",
        cartValidation.data.issues,
      );
    }
    if (!cartValidation.data.delivery) {
      throw new Error("Delivery information is no longer available. Please refresh checkout and try again.");
    }

    const processedItems: CreateOrderPayload["items"] = cartValidation.data.items.map((item) => ({
      cartKey: item.cartKey,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.unitPrice,
      productName: item.productName,
      variantLabel: item.variantLabel,
    }));
    const subtotal = cartValidation.data.subtotal;
    const shippingCharge = cartValidation.data.delivery.shippingCharge;
    const cityName = cartValidation.data.delivery.cityName;
    const zoneName = cartValidation.data.delivery.zoneName;
    const areaName = cartValidation.data.delivery.areaName;
    const discountValidationItems = cartValidation.data.items.map((item) => ({
      id: item.productId,
      name: item.productName,
      price: item.unitPrice,
      quantity: item.quantity,
      variantId: item.variantId,
      freeDelivery: item.freeDelivery,
    }));

    let discountAmount: number | null = null;
    let discountCode: string | null = null;
    let finalNotes = notes || "";

    if (discountJson) {
      const discountData = JSON.parse(discountJson);
      const validationResult = await validateDiscount(
        discountData.code,
        subtotal,
        discountValidationItems,
        shippingCharge,
        customerPhone,
      );

      if (!validationResult?.valid) {
        throw new Error(
          validationResult?.error || "The applied discount is no longer valid.",
        );
      }

      discountAmount = validationResult.discountAmount || null;
      discountCode = validationResult.discount?.code || null;

      if (discountAmount && discountCode) {
        const note = `[Discount Applied: ${discountCode} (-${discountAmount})]`;
        finalNotes = finalNotes ? `${finalNotes}\n${note}` : note;
      }
    }

    const payload: CreateOrderPayload = {
      checkoutRequestId,
      customerName,
      customerPhone,
      customerEmail,
      shippingAddress,
      city: cityId,
      zone: zoneId,
      area: areaId,
      cityName,
      zoneName,
      areaName,
      notes: finalNotes,
      items: processedItems,
      shippingCharge,
      shippingMethodId: shippingLocationId,
      discountAmount,
      discountCode: discountCode || undefined,
      paymentMethod: "cod",
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
