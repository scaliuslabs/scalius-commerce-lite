import type { APIRoute } from "astro";
import { getProductBySlug } from "@/lib/api";
import { getLayoutData } from "@/lib/api/storefront";
import type { CartItem } from "@/store/cart";

export const prerender = false;

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
    const layoutData = await getLayoutData();
    const currencyCode = layoutData?.currency?.code ?? "BDT";
    const searchParams = url.searchParams;
    const requestedVariantId = searchParams.get("variant");
    const quantity = parseInt(searchParams.get("qty") || "1", 10) || 1;

    let itemToAdd: (typeof variants)[0] | null = null;
    if (requestedVariantId) {
      itemToAdd = variants.find((v) => v.id === requestedVariantId) || null;
      if (!itemToAdd) {
        return new Response(null, {
          status: 307,
          headers: { Location: `/products/${slug}?error=variant_not_found` },
        });
      }
    } else if (variants.length > 0) {
      itemToAdd = variants[0];
    }

    let finalPrice = product.discountedPrice;
    if (itemToAdd?.price) {
      const variantPrice = itemToAdd.price;

      // Use variant-specific discount if available, otherwise use product discount
      const hasVariantDiscount =
        (itemToAdd.discountType === "flat" && itemToAdd.discountAmount) ||
        (itemToAdd.discountType === "percentage" &&
          itemToAdd.discountPercentage);

      if (hasVariantDiscount) {
        if (itemToAdd.discountType === "flat" && itemToAdd.discountAmount) {
          finalPrice = Math.max(
            0,
            Math.round(variantPrice - itemToAdd.discountAmount),
          );
        } else if (
          itemToAdd.discountType === "percentage" &&
          itemToAdd.discountPercentage
        ) {
          finalPrice = Math.round(
            variantPrice * (1 - itemToAdd.discountPercentage / 100),
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
    }

    const cartItem: CartItem = {
      id: product.id,
      slug: product.slug,
      name: product.name,
      price: finalPrice,
      image: images.find((img) => img.isPrimary)?.url || images[0]?.url,
      quantity: quantity,
      variantId: itemToAdd?.id,
      size: itemToAdd?.size || undefined,
      color: itemToAdd?.color || undefined,
      freeDelivery: product.freeDelivery,
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
          <img src="${cartItem.image || ""}" alt="${cartItem.name}" class="product-image">
          <p class="product-name">${cartItem.name}</p>
          <p class="status-text" id="status-text">Adding to cart & preparing checkout...</p>
          <div class="loader"><div class="loader-bar"></div></div>
        </div>

        <script>
          try {
            sessionStorage.setItem('quickBuyData', JSON.stringify(${JSON.stringify(dataToStore)}));
          } catch (e) {
            console.error('Could not save quick-buy data to session storage.', e);
          } finally {
            setTimeout(() => {
              window.location.href = '/cart';
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
  } catch (error) {
    console.error(`Error in /buy handler for slug ${slug}:`, error);
    return new Response(null, {
      status: 307,
      headers: { Location: "/cart?error=processing_failed" },
    });
  }
};
