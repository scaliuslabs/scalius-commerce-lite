import { MAX_LINE_QUANTITY } from "@scalius/shared/order-limits";
import type { APIRoute } from "astro";
import { getProductBySlug } from "@/lib/api";
import { getLayoutData } from "@/lib/api/storefront";
import { setRuntimeImageCdnPolicy } from "@/lib/api/runtime";
import { getProductImageUrl } from "@/lib/product-media";
import { serializeJsonForInlineScript } from "@/lib/safe-json";
import { cspHashSource } from "@scalius/shared/http-security";
import { ownCspHeaders } from "@/lib/middleware-helper/own-csp";
import { validateCartItems, type CartValidationIssue } from "@/lib/api/orders";
import type { CartItem, CartItemOption } from "@/store/cart";
import type { ProductVariant } from "@/lib/api/types";
import { escapeHtml } from "@scalius/shared/html-escape";
import { storefrontCopy, storefrontLanguage } from "@/lib/storefront-copy";
import { resolveBuyerVariants } from "@/lib/product-sellable-variants";
import {
  cartLinePropertiesFromOrderLine,
  productBuyerInputSchema,
  resolveProductPageCopy,
  readPostedBuyerInputs,
} from "@/components/product/lib/buyer-inputs";
import {
  canonicalizeLineProperties,
  resolveLineProperties,
  withAnswerRevisions,
  type LinePropertyInput,
} from "@scalius/shared/line-properties";
import { normalizeCartLinePurchaseOptions } from "@/lib/cart/purchase-option";
import { toLatinDigits } from "@scalius/shared/phone-input";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { QUICK_CHECKOUT_PATH, quickBuyNoScriptForm } from "@/lib/checkout/quick-checkout";
import { serverPagePath } from "@/lib/server-presence";
import { isCartLineRefusal, validateNewCartLine } from "@/lib/cart/new-line";
import { resolveRequestTheme } from "@/lib/storefront-theme-context";
import { themePaint, type ThemePaint } from "@/lib/theme-paint";
import { colorSchemeBootScript } from "@/lib/color-scheme";
import { readBoundedForm } from "@/lib/bounded-body";

export const prerender = false;

/** The no-JavaScript buyer-inputs form is small; anything larger is not it. */
const MAX_FORM_BODY_BYTES = 32 * 1024;

function parseQuickBuyQuantity(value: string | null): number | null {
  if (!value) return 1;
  value = toLatinDigits(value).trim();
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) return null;
  return quantity;
}

/**
 * Back to the product page with a notice code. Only the code travels in the
 * URL, never a buyer input. A form POST answers 303 so the page is fetched
 * with GET.
 */
function productRedirectWithStatus(slug: string, error: string, status: 303 | 307): Response {
  return new Response(null, {
    status,
    headers: { Location: `/products/${slug}?error=${encodeURIComponent(error)}` },
  });
}

function issueToQuickBuyError(issue: CartValidationIssue | undefined): string {
  if (!issue) return "validation_unavailable";
  switch (issue.code) {
    case "product_unavailable":
      return "product_unavailable";
    case "variant_required":
      return "variant_required";
    case "variant_unavailable":
    case "variant_mismatch":
      return "variant_not_found";
    case "quantity_unavailable":
      return issue.availableQuantity && issue.availableQuantity > 0
        ? "quantity_unavailable"
        : "out_of_stock";
    case "properties_required":
      return "customization_required";
    case "properties_invalid":
    case "confirmation_required":
    case "decision_required":
      return "customization_invalid";
    case "purchase_option_unavailable":
      return "purchase_option_unavailable";
    default:
      return "validation_unavailable";
  }
}

/** The options the store accepted on the line, with their titles, as the cart line keeps them. */
function validatedPurchaseOptions(value: unknown): Pick<CartItem, "purchaseOptions"> {
  const options = normalizeCartLinePurchaseOptions(value) ?? [];
  return options.length > 0 ? { purchaseOptions: options } : {};
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

interface QuickBuyRequest {
  slug: string;
  requestedVariantId: string | null;
  quantity: string | null;
  /** Buyer inputs from the product-page form (POST); null for a quick-buy link. */
  properties: LinePropertyInput[] | null;
  /** The apps' purchase options chosen in the form (POST, one per app); empty: one-time. */
  purchaseOptions: string[];
  redirectStatus: 303 | 307;
  /** The request, for the theme the handoff page paints. */
  page: { request: Request; locals: object };
}

/** The handoff page's paint: the store's theme and its colour scheme, as every page draws them; none if it cannot be read. */
async function handoffPaint(page: QuickBuyRequest["page"], layoutData: Parameters<typeof resolveRequestTheme>[1]): Promise<{ paint: ThemePaint; script: string } | null> {
  try {
    const theme = await resolveRequestTheme(page, layoutData);
    const paint = themePaint(theme.theme, theme.resolved);
    return { paint, script: colorSchemeBootScript(paint.colorScheme, theme.preview === null) };
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ params, url, request, locals }) => {
  const { slug } = params;
  if (!slug) {
    return new Response(null, { status: 307, headers: { Location: "/cart" } });
  }
  return quickBuy({
    slug,
    requestedVariantId: url.searchParams.get("variant"),
    quantity: url.searchParams.get("qty"),
    properties: null,
    purchaseOptions: [],
    redirectStatus: 307,
    page: { request: request ?? new Request(url), locals: locals ?? {} },
  });
};

function isFormBody(request: Request): boolean {
  const type = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  return type === "application/x-www-form-urlencoded" || type === "multipart/form-data";
}

/**
 * The product page's buyer-inputs form, before the product script runs or
 * without JavaScript: the inputs arrive in the body, are checked against the
 * product's schema and priced by cart validation, then join the cart through
 * the same page as a quick-buy link.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const { slug } = params;
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(null, { status: 403 });
  }
  if (!slug) {
    return new Response(null, { status: 303, headers: { Location: "/cart" } });
  }
  if (!isFormBody(request)) {
    return new Response(null, { status: 415 });
  }
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_FORM_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  const read = await readBoundedForm(request, MAX_FORM_BODY_BYTES);
  if (!read.ok) return new Response(null, { status: read.reason === "too_large" ? 413 : 400 });
  const form = read.value;
  const posted = readPostedBuyerInputs(form.entries());
  if (!posted.ok) {
    return productRedirectWithStatus(slug, "customization_invalid", 303);
  }
  return quickBuy({
    slug,
    requestedVariantId: posted.variantId,
    quantity: posted.quantity,
    properties: posted.properties,
    purchaseOptions: posted.purchaseOptions,
    redirectStatus: 303,
    page: { request, locals: locals ?? {} },
  });
};

async function quickBuy({
  slug,
  requestedVariantId,
  quantity: requestedQuantity,
  properties: postedProperties,
  purchaseOptions,
  redirectStatus,
  page,
}: QuickBuyRequest): Promise<Response> {
  const productRedirect = (target: string, error: string) =>
    productRedirectWithStatus(target, error, redirectStatus);
  try {
    const productData = await getProductBySlug(slug, false);
    if (!productData) {
      return new Response(null, {
        status: redirectStatus,
        headers: { Location: "/?error=product_not_found" },
      });
    }

    const { product, variants, category } = productData;
    // A broken buyer-input setup can't be bought; a required input can only
    // be filled on the product page (a quick-buy link has none).
    if (product.customizationUnavailable) {
      return productRedirect(slug, "customization_unavailable");
    }
    const layoutData = await getLayoutData();
    // The product's own inputs, then the active apps' line inputs that apply
    // to the SKU being bought (an app's input shown by SKU), as the form drew them.
    const requestedVariant = variants.find((variant) => variant.id === requestedVariantId) ?? (variants.length === 1 ? variants[0]! : null);
    const schema = productBuyerInputSchema(product, layoutData?.lineInputs, resolveProductPageCopy(layoutData?.storefrontCopy), requestedVariant);
    if (postedProperties === null && product.requiresCustomization) {
      return productRedirect(slug, "customization_required");
    }
    const canonicalProperties = postedProperties === null
      ? []
      : canonicalizeLineProperties(schema, postedProperties);
    // Posted from the words the page drew: each answer names their revision (merchant-written words).
    const answeredProperties = withAnswerRevisions(schema, canonicalProperties);
    const resolvedProperties = resolveLineProperties(schema, answeredProperties);
    if (!resolvedProperties.ok) {
      return productRedirect(
        slug,
        resolvedProperties.code === "properties_required" ? "customization_required" : "customization_invalid",
      );
    }
    const buyerVariantResolution = resolveBuyerVariants(variants);
    const buyerVariants = buyerVariantResolution.variants;
    const hasCustomerOptions = buyerVariantResolution.hasCustomerOptions;
    if (buyerVariants.length === 0) {
      return productRedirect(slug, "product_unavailable");
    }
    setRuntimeImageCdnPolicy(layoutData?.media);
    const currencyCode = layoutData?.currency?.code ?? "BDT";
    const quantity = parseQuickBuyQuantity(requestedQuantity);
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

    // The store prices the line (an app its purchase option): sent without a price, it answers today's.
    let failed = false;
    let refusal: unknown = null;
    const checked = await validateNewCartLine(async (items) => {
      const result = await validateCartItems(items);
      if (result.success) return result.data;
      failed = true;
      refusal = result.details;
      return null;
    }, {
      cartKey: `quick_buy:${product.id}:${itemToAdd.id}`,
      productId: product.id,
      variantId: itemToAdd.id,
      quantity,
      productName: product.name,
      variantLabel: variantLabel(itemToAdd),
      ...(resolvedProperties.canonical.length > 0 ? { properties: withAnswerRevisions(schema, resolvedProperties.canonical) } : {}),
      ...(purchaseOptions.length > 0 ? { purchaseOptions } : {}),
    });
    const validation = !failed && checked && !isCartLineRefusal(checked) ? { success: true as const, data: checked } : { success: false as const };
    if (!validation.success) {
      // Two apps both priced the line: the buyer chooses again, on the page.
      const reason = (refusal as { reason?: unknown } | null)?.reason;
      return productRedirect(slug, reason === "purchase_options_conflict" ? "purchase_options_conflict" : "validation_unavailable");
    }
    // A store app's rule ("at most 10 per order") is not this item's problem:
    // the cart says it in the app's words and blocks checkout until it holds.
    const blockedOnlyByRules =
      validation.data.issues.length === 0 && (validation.data.ruleErrors?.length ?? 0) > 0;
    if (!validation.data.valid && !blockedOnlyByRules) {
      return productRedirect(slug, issueToQuickBuyError(validation.data.issues[0]));
    }

    const validatedItem = validation.data.items[0];
    if (!validatedItem) {
      return productRedirect(slug, "validation_unavailable");
    }
    const finalPrice = validatedItem.unitPrice;
    const persistedVariantId = validatedItem.variantId;
    if (!persistedVariantId || persistedVariantId === "default") {
      return productRedirect(slug, "variant_not_found");
    }

    // Cart presentation comes from the same authoritative validation that
    // checked price and stock. It is always an image/poster, never video.
    const cartImageUrl = getProductImageUrl(validatedItem.productImage ?? "", 160);
    const options = cartItemOptions(itemToAdd);
    // The server's resolved inputs (labels, display values, surcharges) are
    // what the cart line keeps; the cart page hashes them into the line key.
    const properties = cartLinePropertiesFromOrderLine(validatedItem.properties);
    if (resolvedProperties.canonical.length > 0 && properties.length === 0) {
      return productRedirect(slug, "validation_unavailable");
    }
    const fulfillmentKind = validatedItem.fulfillmentKind ?? itemToAdd.fulfillmentKind;
    const cartItem: CartItem = {
      id: product.id,
      slug: product.slug,
      name: validatedItem.productName,
      price: finalPrice,
      image: cartImageUrl,
      ...(validatedItem.productImageMediaId
        ? { imageMediaId: validatedItem.productImageMediaId }
        : {}),
      quantity,
      variantId: persistedVariantId,
      ...(options.length > 0 ? { options } : {}),
      freeDelivery: validatedItem.freeDelivery,
      ...(properties.length > 0 ? { properties } : {}),
      ...validatedPurchaseOptions(validatedItem.purchaseOptions),
      ...(fulfillmentKind ? { fulfillmentKind } : {}),
    };

    // Analytics carry the SKU, quantity and price only, never the buyer inputs.
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
    // Without JavaScript the line cannot reach the browser cart: it goes on
    // in the body of a form to the no-JavaScript checkout instead.
    const language = storefrontLanguage(layoutData?.storefrontCopy?.languageCode);
    const words = storefrontCopy(language).quickBuy;
    const noScriptCheckout = quickBuyNoScriptForm(
      { [`quick_buy:${cartItem.id}:${cartItem.variantId}`]: cartItem },
      words.continue,
      // Under the page's presence: the order keeps the buyer's language.
      serverPagePath(QUICK_CHECKOUT_PATH),
    );

    // The store's colours and scheme, painted before first paint as on every page (the theme's alone: no buyer variance).
    const theme = await handoffPaint(page, layoutData);
    const scheme = theme?.paint.colorScheme?.scheme;
    const quickBuyScript = `
          const quickBuyData = ${quickBuyStorageValue};
          try {
            sessionStorage.setItem('quickBuyData', quickBuyData);
            if (sessionStorage.getItem('quickBuyData') !== quickBuyData) {
              throw new Error('Quick-buy storage was not persisted.');
            }
            setTimeout(() => {
              window.location.href = '${serverPagePath("/cart")}';
            }, 400);
          } catch (e) {
            console.error('Could not save quick-buy data to session storage.', e);
            const statusText = document.getElementById('status-text');
            if (statusText) {
              statusText.textContent = ${serializeJsonForInlineScript(words.failed)};
            }
            setTimeout(() => {
              window.location.href = '${serverPagePath("/cart?quickBuyStorage=blocked")}';
            }, 400);
          }
        `;
    const html = `
      <!DOCTYPE html>
      <html lang="${language}"${scheme ? ` data-color-scheme="${scheme}"` : ""}>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${escapeHtml(words.title)}</title>
        ${theme?.script ? `<script>${theme.script}</script>` : ""}
        ${theme ? `<style>${theme.paint.css}</style>` : ""}
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: var(--muted, #f3f4f6); color: var(--foreground, #1f2937); display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
          .card { background-color: var(--card, #ffffff); color: var(--card-foreground, #1f2937); border: 1px solid var(--border, #e5e7eb); border-radius: 0.75rem; padding: 2rem; text-align: center; max-width: 320px; width: 100%; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05); transform: translateY(-20px); opacity: 0; animation: fadeIn 0.5s 0.1s ease-out forwards; }
          .product-image { width: 80px; height: 80px; border-radius: 0.5rem; object-fit: cover; margin: 0 auto 1rem; border: 1px solid var(--border, #e5e7eb); }
          .product-name { font-weight: 600; margin: 0 0 0.5rem; font-size: 1rem; }
          .status-text { color: var(--muted-foreground, #4b5563); margin: 0 0 1.5rem; font-size: 0.9rem; }
          .loader { height: 4px; width: 100%; background-color: var(--muted, #e5e7eb); border-radius: 2px; overflow: hidden; }
          .loader-bar { display: block; height: 100%; width: 100%; background-color: var(--primary, #059669); border-radius: 2px; transform: translateX(-100%); animation: loading 1.5s linear infinite; }
          @keyframes fadeIn { to { transform: translateY(0); opacity: 1; } }
          @keyframes loading { 0% { transform: translateX(-100%); } 50% { transform: translateX(0%); } 100% { transform: translateX(100%); } }
          /* No motion for a buyer who asks for none: the card is simply there, the bar still. */
          @media (prefers-reduced-motion: reduce) {
            .card { animation: none; opacity: 1; transform: none; }
            .loader-bar { animation: none; transform: none; }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <img src="${escapeHtml(cartImageUrl)}" alt="${escapeHtml(cartItem.name)}" class="product-image">
          <p class="product-name">${escapeHtml(cartItem.name)}</p>
          <p class="status-text" id="status-text">${escapeHtml(words.preparing)}</p>
          <div class="loader"><div class="loader-bar"></div></div>
          ${noScriptCheckout}
        </div>

        <script>${quickBuyScript}</script>
      </body>
      </html>
    `;

    // The page owns its policy: it runs only the two scripts it wrote, by their hashes.
    const scriptSources = await Promise.all([theme?.script, quickBuyScript].filter((script): script is string => Boolean(script)).map(cspHashSource));
    return new Response(html, {
      status: 200,
      // The page carries the cart line (and any buyer inputs): never cached.
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "private, no-store",
        ...ownCspHeaders(`default-src 'none'; script-src ${scriptSources.join(" ")}; style-src 'unsafe-inline'; img-src 'self' https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`),
      },
    });
  } catch (error: unknown) {
    console.error(`Error in /buy handler for slug ${slug}:`, error);
    return new Response(null, {
      status: redirectStatus,
      headers: { Location: "/cart?error=processing_failed" },
    });
  }
}
