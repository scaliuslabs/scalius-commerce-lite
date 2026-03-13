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

export async function getCities(): Promise<LocationData[]> {
  try {
    const citiesData = await getCitiesFromApi();
    return citiesData || [];
  } catch (error) {
    console.error("Failed to fetch cities from API via library:", error);
    return [];
  }
}

export async function processOrder(formData: FormData) {
  try {
    const customerName = formData.get("customerName") as string;
    let customerPhone = (formData.get("customerPhone") as string)
      .replace(/^\+?880/, "")
      .trim();
    if (customerPhone.startsWith("1")) {
      customerPhone = "0" + customerPhone;
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
    const cartItemsArray = Object.values(cartItems) as any[];

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
    if (!/^01[3-9]\d{8}$/.test(customerPhone)) {
      throw new Error("Please enter a valid Bangladeshi phone number");
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
    } catch (locationError) {
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

      // Validate quantity bounds (defense-in-depth; backend Zod also checks >= 1)
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 99
      ) {
        throw new Error(
          `Invalid quantity for "${item.name || "item"}". Must be between 1 and 99.`,
        );
      }

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
                Math.round(variantPrice - variant.discountAmount),
              );
            } else if (
              variant.discountType === "percentage" &&
              variant.discountPercentage
            ) {
              finalPrice = Math.round(
                variantPrice * (1 - variant.discountPercentage / 100),
              );
            }
          } else {
            // Apply product-level discount
            if (product.discountType === "flat" && product.discountAmount) {
              finalPrice = Math.max(
                0,
                Math.round(variantPrice - product.discountAmount),
              );
            } else if (
              product.discountType === "percentage" &&
              product.discountPercentage
            ) {
              finalPrice = Math.round(
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

      subtotal += finalPrice * item.quantity;
      processedItems.push({
        productId: product.id,
        variantId: variantId,
        quantity: item.quantity,
        price: finalPrice,
      });
    }

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
        } catch (err) {
          // The try/catch ensures that even if this cleanup fails, the user journey is not interrupted.
          // The error is already logged inside the deleteAbandonedCheckout function.
          console.warn(
            `[Non-critical] Failed to delete abandoned checkout record ${checkoutId} after successful order.`,
          );
        }
      }
    }

    return result;
  } catch (error) {
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
