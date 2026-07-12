import type { APIRoute } from "astro";
import { getProductBySlug } from "@/lib/api";
import { getLayoutData } from "@/lib/api/storefront";
import { setRuntimeImageCdnPolicy } from "@/lib/api/runtime-env";
import { getProductImageUrl, hasProductImage } from "@/lib/product-media";
import { serializeJsonForInlineScript } from "@/lib/safe-json";
import { validateCartItems, type CartValidationIssue } from "@/lib/api/orders";
import type { CartItem, CartItemOption } from "@/store/cart";
import type { ProductVariant } from "@/lib/api/types";
import { escapeHtml } from "@scalius/shared/html-escape";
import { resolveBuyerVariants } from "@/lib/product-sellable-variants";
import { calculateVariantPrice } from "@/components/product/lib/pricing-engine";

export const prerender = false;

function parseQuickBuyQuantity(value: string | null): number | null {
  if (!value) return 1;
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) return null;
  return quantity;
}

function productRedirect(slug: string, error: string): Response {
  return new Response(null, {
    status: 307,
    headers: { Location: `/products/${slug}?error=${encodeURIComponent(error)}` },
  });
}

function issueToQuickBuyError(issue: CartValidationIssue | undefined): string {
  if (!issue) return "validation_unavailable";
  switch (issue.code) {
    case "PRODUCT_UNAVAILABLE":
      return "product_unavailable";
    case "VARIANT_REQUIRED":
      return "variant_required";
    case "VARIANT_UNAVAILABLE":
    case "VARIANT_MISMATCH":
      return "variant_not_found";
    case "QUANTITY_UNAVAILABLE":
      return issue.availableQuantity && issue.availableQuantity > 0
        ? "quantity_unavailable"
        : "out_of_stock";
    case "PRICE_CHANGED":
      return "price_changed";
    default:
      return "validation_unavailable";
  }
}

function variantLabel(variant: ProductVariant | null): string | null {
  if (!variant) return null;
  const parts = variant.selectedOptions.map((option) => option.value);
  return parts.length ? parts.join(" / ") : null;
}

function cartItemOptions(
  variant: ProductVariant | null,
): CartItemOption[] {
  if (!variant) return [];
  return variant.selectedOptions.map((option) => ({ name: option.name, label: option.value }));
}

export const GET: APIRoute = async ({ params, url }) => {
  const { slug } = params;
  if (!slug) {
    return new Response(null, { status: 307, headers: { Location: "/cart" } });
  }

  try {
    const productData = await getProductBySlug(slug, false);
    if (!productData) {
      return new Response(null, {
        status: 307,
        headers: { Location: "/?error=product_not_found" },
      });
    }

    const { product, images, variants, category } = productData;
    const buyerVariantResolution = resolveBuyerVariants(variants);
    const buyerVariants = buyerVariantResolution.variants;
    const hasCustomerOptions = buyerVariantResolution.hasCustomerOptions;
    if (buyerVariants.length === 0) {
      return productRedirect(slug, "product_unavailable");
    }
    const layoutData = await getLayoutData();
    setRuntimeImageCdnPolicy(layoutData?.media);
    const currencyCode = layoutData?.currency?.code ?? "BDT";
    const searchParams = url.searchParams;
    const requestedVariantId = searchParams.get("variant");
    const quantity = parseQuickBuyQuantity(searchParams.get("qty"));
    if (quantity === null) {
      return productRedirect(slug, "invalid_quantity");
    }

    let itemToAdd: (typeof variants)[0] | null = null;
    if (requestedVariantId) {
      itemToAdd = buyerVariants.find((v) => v.id === requestedVariantId) || null;
      if (!itemToAdd) {
        return productRedirect(slug, "variant_not_found");
      }
    } else if (hasCustomerOptions) {
      return productRedirect(slug, "variant_required");
    } else if (buyerVariants.length === 1) {
      itemToAdd = buyerVariants[0];
    } else {
      return productRedirect(slug, "variant_required");
    }

    let finalPrice = calculateVariantPrice(
      {
        basePrice: product.price,
        discountType: product.discountType,
        discountPercentage: product.discountPercentage,
        discountAmount: product.discountAmount,
        currencyDecimalPlaces: layoutData?.currency?.decimalPlaces,
      },
      {
        price: itemToAdd.price,
        discountType: itemToAdd.discountType,
        discountPercentage: itemToAdd.discountPercentage,
        discountAmount: itemToAdd.discountAmount,
      },
    ).finalPrice;

    const validation = await validateCartItems([{
      cartKey: `quick_buy:${product.id}:${itemToAdd.id}`,
      productId: product.id,
      variantId: itemToAdd.id,
      quantity,
      price: finalPrice,
      productName: product.name,
      variantLabel: variantLabel(itemToAdd),
    }]);
    if (!validation.success) {
      return productRedirect(slug, "validation_unavailable");
    }
    if (!validation.data.valid) {
      return productRedirect(slug, issueToQuickBuyError(validation.data.issues[0]));
    }

    const validatedItem = validation.data.items[0];
    if (!validatedItem) {
      return productRedirect(slug, "validation_unavailable");
    }
    finalPrice = validatedItem.unitPrice;
    const persistedVariantId = validatedItem.variantId;
    if (!persistedVariantId || persistedVariantId === "default") {
      return productRedirect(slug, "variant_not_found");
    }

    const primaryImageUrl =
      images.find((img) => img.id === itemToAdd?.imageId && hasProductImage(img.url))?.url ||
      images.find((img) => img.isPrimary && hasProductImage(img.url))?.url ||
      images.find((img) => hasProductImage(img.url))?.url ||
      product.imageUrl ||
      "";
    const cartImageUrl = getProductImageUrl(primaryImageUrl, {
      width: 160,
      height: 160,
      quality: 75,
      format: "auto",
      fit: "contain",
    });
    const options = cartItemOptions(itemToAdd);
    const cartItem: CartItem = {
      id: product.id,
      slug: product.slug,
      name: validatedItem.productName,
      price: finalPrice,
      image: cartImageUrl,
      quantity,
      variantId: persistedVariantId,
      ...(options.length > 0 ? { options } : {}),
      freeDelivery: validatedItem.freeDelivery,
    };

    const variantIdForAnalytics = cartItem.variantId || cartItem.id;
    const totalValue = cartItem.price * cartItem.quantity;
    const eventContents = [
      {
        id: variantIdForAnalytics,
        quantity: cartItem.quantity,
        item_price: cartItem.price,
      },
    ];

    const addToCartEventData = {
      content_ids: [variantIdForAnalytics],
      content_name: cartItem.name,
      content_type: "product",
      contents: eventContents,
      currency: currencyCode,
      value: totalValue,
    };

    const initiateCheckoutEventData = {
      ...addToCartEventData,
      content_category: category?.name,
      num_items: cartItem.quantity,
    };

    const dataToStore = {
      cartItem,
      addToCartEvent: addToCartEventData,
      initiateCheckoutEvent: initiateCheckoutEventData,
    };
    const quickBuyStorageValue = serializeJsonForInlineScript(
      JSON.stringify(dataToStore),
    );

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Adding to Cart...</title>
        <style>
          :root { --primary-color: #059669; /* Fallback primary color */ }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f3f4f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
          .card { background-color: #ffffff; border-radius: 0.75rem; padding: 2rem; text-align: center; max-width: 320px; width: 100%; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05); transform: translateY(-20px); opacity: 0; animation: fadeIn 0.5s 0.1s ease-out forwards; }
          .product-image { width: 80px; height: 80px; border-radius: 0.5rem; object-fit: cover; margin: 0 auto 1rem; border: 1px solid #e5e7eb; }
          .product-name { font-weight: 600; color: #1f2937; margin: 0 0 0.5rem; font-size: 1rem; }
          .status-text { color: #4b5563; margin: 0 0 1.5rem; font-size: 0.9rem; }
          .loader { height: 4px; width: 100%; background-color: #e5e7eb; border-radius: 2px; overflow: hidden; }
          .loader-bar { content: ''; display: block; height: 100%; width: 100%; background-color: var(--primary-color); border-radius: 2px; transform: translateX(-100%); animation: loading 1.5s linear infinite; }
          @keyframes fadeIn { to { transform: translateY(0); opacity: 1; } }
          @keyframes loading { 0% { transform: translateX(-100%); } 50% { transform: translateX(0%); } 100% { transform: translateX(100%); } }
        </style>
      </head>
      <body>
        <div class="card">
          <img src="${escapeHtml(cartImageUrl)}" alt="${escapeHtml(cartItem.name)}" class="product-image">
          <p class="product-name">${escapeHtml(cartItem.name)}</p>
          <p class="status-text" id="status-text">Adding to cart & preparing checkout...</p>
          <div class="loader"><div class="loader-bar"></div></div>
        </div>

        <script>
          const quickBuyData = ${quickBuyStorageValue};
          try {
            sessionStorage.setItem('quickBuyData', quickBuyData);
            if (sessionStorage.getItem('quickBuyData') !== quickBuyData) {
              throw new Error('Quick-buy storage was not persisted.');
            }
            setTimeout(() => {
              window.location.href = '/cart';
            }, 400);
          } catch (e) {
            console.error('Could not save quick-buy data to session storage.', e);
            const statusText = document.getElementById('status-text');
            if (statusText) {
              statusText.textContent = 'Could not prepare quick buy. Returning to cart...';
            }
            setTimeout(() => {
              window.location.href = '/cart?quickBuyStorage=blocked';
            }, 400);
          }
        </script>
      </body>
      </html>
    `;

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  } catch (error: unknown) {
    console.error(`Error in /buy handler for slug ${slug}:`, error);
    return new Response(null, {
      status: 307,
      headers: { Location: "/cart?error=processing_failed" },
    });
  }
};
