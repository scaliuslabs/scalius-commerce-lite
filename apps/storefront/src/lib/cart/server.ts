// src/lib/cart/server.ts

import {
  createOrder,
  type CreateOrderPayload,
  getCities as getCitiesFromApi,
  getZones,
  getAreas,
  getProductBySlug,
  getShippingMethods,
  validateDiscount,
  recordDiscountUsage,
  type LocationData,
  deleteAbandonedCheckout,
} from "@/lib/api";
import { roundPrice } from "@scalius/shared/price-utils";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";

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
  id: string;
  slug?: string;
  name: string;
  price: number;
  quantity: number;
  image?: string;
  variantId?: string;
  size?: string;
  color?: string;
  freeDelivery?: boolean;
}

function validateCartItems(raw: unknown): ValidatedCartItem[] {
  if (raw === null || typeof raw !== "object") {
    throw new Error("Cart data must be a non-null object.");
  }

  const entries = Object.values(raw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("Cart is empty.");
  }

  return entries.map((entry, idx) => {
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
      id: item.id as string,
      slug: optionalStr("slug"),
      name: item.name as string,
      price: item.price as number,
      quantity: item.quantity as number,
      image: optionalStr("image"),
      variantId: optionalStr("variantId"),
      size: optionalStr("size"),
      color: optionalStr("color"),
      freeDelivery: typeof item.freeDelivery === "boolean" ? item.freeDelivery : undefined,
    };
  });
}

export async function processOrder(formData: FormData) {
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

    const cartItems = JSON.parse(cartItemsJson);
    // Validate cart item shape and value ranges (defense against crafted form data)
    const cartItemsArray = validateCartItems(cartItems);

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

    let cityName: string | undefined = undefined;
    let zoneName: string | undefined = undefined;
    let areaName: string | undefined = undefined;

    try {
      const allCities = await getCitiesFromApi();
      const city = allCities?.find((c) => c.id === cityId);
      if (city) cityName = city.name;

      if (zoneId) {
        const allZones = await getZones(cityId);
        const zone = allZones?.find((z) => z.id === zoneId);
        if (zone) zoneName = zone.name;
      }

      if (areaId && zoneId) {
        const allAreas = await getAreas(zoneId);
        const area = allAreas?.find((a) => a.id === areaId);
        if (area) areaName = area.name;
      }
    } catch (locationError: unknown) {
      console.error("Error fetching location names:", locationError);
    }

    let shippingCharge = 0;
    const allShippingMethods = await getShippingMethods();
    const selectedMethod = allShippingMethods?.find(
      (method) => method.id === shippingLocationId,
    );
    if (selectedMethod) {
      shippingCharge = selectedMethod.fee;
    } else {
      throw new Error("Invalid shipping method selected.");
    }

    // --- PERFORMANCE OPTIMIZATION: Fetch all product data in parallel ---
    const productPromises = cartItemsArray.map((item) =>
      getProductBySlug(item.slug || item.id),
    );
    const productDataResults = await Promise.all(productPromises);

    const processedItems: CreateOrderPayload["items"] = [];
    let subtotal = 0;

    for (let i = 0; i < cartItemsArray.length; i++) {
      const item = cartItemsArray[i];
      const productData = productDataResults[i];

      // Quantity bounds already validated by validateCartItems()

      if (!productData) {
        throw new Error(`Product "${item.name}" is no longer available.`);
      }

      const { product, variants } = productData;
      let finalPrice = product.discountedPrice;
      let variantId: string | null = null;
      let availableStock = 0;

      if (item.variantId && item.variantId !== "default") {
        const variant = variants.find((v) => v.id === item.variantId);
        if (variant) {
          variantId = variant.id;
          const variantPrice = variant.price || product.price;

          // Use variant-specific discount if available, otherwise use product discount
          const hasVariantDiscount =
            (variant.discountType === "flat" && variant.discountAmount) ||
            (variant.discountType === "percentage" &&
              variant.discountPercentage);

          if (hasVariantDiscount) {
            if (variant.discountType === "flat" && variant.discountAmount) {
              finalPrice = Math.max(
                0,
                roundPrice(variantPrice - variant.discountAmount),
              );
            } else if (
              variant.discountType === "percentage" &&
              variant.discountPercentage
            ) {
              finalPrice = roundPrice(
                variantPrice * (1 - variant.discountPercentage / 100),
              );
            }
          } else {
            // Apply product-level discount
            if (product.discountType === "flat" && product.discountAmount) {
              finalPrice = Math.max(
                0,
                roundPrice(variantPrice - product.discountAmount),
              );
            } else if (
              product.discountType === "percentage" &&
              product.discountPercentage
            ) {
              finalPrice = roundPrice(
                variantPrice * (1 - product.discountPercentage / 100),
              );
            } else {
              finalPrice = variantPrice;
            }
          }

          availableStock = variant.stock - (variant.reservedStock ?? 0);
        } else {
          throw new Error(
            `Selected variant for "${product.name}" is no longer available.`,
          );
        }
      } else {
        // If no variant is specified, stock is the sum of all available variants
        availableStock = variants.reduce((sum, v) => sum + (v.stock - (v.reservedStock ?? 0)), 0);
      }

      if (availableStock < item.quantity) {
        throw new Error(
          `Insufficient stock for ${product.name}. Available: ${availableStock}, Requested: ${item.quantity}`,
        );
      }

      subtotal += roundPrice(finalPrice * item.quantity);
      processedItems.push({
        productId: product.id,
        variantId: variantId,
        quantity: item.quantity,
        price: finalPrice,
      });
    }

    subtotal = roundPrice(subtotal);

    // Check if any product in the order qualifies for free delivery.
    // This must match the client-side logic so the order total is consistent
    // with what the customer saw at checkout.
    const hasFreeDeliveryProduct = productDataResults.some(
      (data) => data?.product?.freeDelivery === true,
    );
    if (hasFreeDeliveryProduct) {
      shippingCharge = 0;
    }

    let discountId: string | null = null;
    let discountAmount: number | null = null;
    let discountCode: string | null = null;
    let finalNotes = notes || "";

    if (discountJson) {
      const discountData = JSON.parse(discountJson);
      const validationResult = await validateDiscount(
        discountData.code,
        subtotal,
        Object.values(cartItems),
        shippingCharge,
        customerPhone,
      );

      if (!validationResult?.valid) {
        throw new Error(
          validationResult?.error || "The applied discount is no longer valid.",
        );
      }

      discountId = validationResult.discount?.id || null;
      discountAmount = validationResult.discountAmount || null;
      discountCode = validationResult.discount?.code || null;

      if (discountAmount && discountCode) {
        const note = `[Discount Applied: ${discountCode} (-${discountAmount})]`;
        finalNotes = finalNotes ? `${finalNotes}\n${note}` : note;
      }
    }

    const payload: CreateOrderPayload = {
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
      discountAmount,
      discountCode: discountCode || undefined,
      paymentMethod: "cod",
    };

    const result = await createOrder(payload);

    if (result.success && result.orderId) {
      // Log discount usage if applicable
      if (discountId && discountAmount && discountAmount > 0) {
        // We can also make this non-blocking but ensure it runs
        await recordDiscountUsage(
          discountId,
          result.orderId,
          null,
          discountAmount,
        );
      }

      // If the order was successful, await the deletion of the abandoned checkout record.
      if (checkoutId) {
        try {
          // By adding 'await', we ensure this request completes before the function terminates.
          await deleteAbandonedCheckout(checkoutId);
          console.log(
            `Successfully deleted abandoned checkout record: ${checkoutId}`,
          );
        } catch (err: unknown) {
          // The try/catch ensures that even if this cleanup fails, the user journey is not interrupted.
          // The error is already logged inside the deleteAbandonedCheckout function.
          console.warn(
            `[Non-critical] Failed to delete abandoned checkout record ${checkoutId} after successful order.`,
          );
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
