// The buyer's cart as checkout prices it: one line shape and one validation
// call for the cart check (and its discounts) and the tax quote, so the cart
// page, the quote and the order read the same lines at the same prices (the
// apps' line prices, add-ons and bundles, buyer inputs and purchase options).
import { z } from "@hono/zod-openapi";
import { MAX_LINE_QUANTITY } from "@scalius/shared/order-limits";
import {
  checkoutLineInputs,
  checkoutPurchaseOptions,
  createAppLinePricer,
  createCartTransformer,
  validateStorefrontCartItems,
} from "@scalius/core/modules/checkout";
import type { Database } from "@scalius/database/client";
import { linePropertiesInputSchema, linePurchaseOptionsInputSchema } from "../../schemas/order-lines";
import { persistedStorefrontVariantIdSchema } from "./shared";

/** A cart line as the buyer holds it: no price, the store prices it. */
export const buyerCartLineSchema = z.object({
  cartKey: z.string().min(1).max(256).optional().nullable(),
  productId: z.string().min(1, "Product is required").max(180),
  variantId: persistedStorefrontVariantIdSchema,
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(MAX_LINE_QUANTITY, `Quantity must be at most ${MAX_LINE_QUANTITY}`),
  productName: z.string().max(255).optional().nullable(),
  variantLabel: z.string().max(500).optional().nullable(),
  properties: linePropertiesInputSchema,
  purchaseOptions: linePurchaseOptionsInputSchema,
});

type ValidateOptions = NonNullable<Parameters<typeof validateStorefrontCartItems>[2]>;
type CheckoutApps = Parameters<typeof createAppLinePricer>[1];
type AppContext = Parameters<typeof createAppLinePricer>[2];

/** The cart priced by the catalogue and the apps, exactly as checkout prices it. */
export function validateBuyerCart(
  db: Database,
  apps: CheckoutApps,
  input: {
    items: Parameters<typeof validateStorefrontCartItems>[1];
    inventoryPool?: ValidateOptions["inventoryPool"];
    currency: { code: string; priceIncrementMinor: number };
    market: ValidateOptions["market"];
    appContext: AppContext;
  },
) {
  return validateStorefrontCartItems(db, input.items, {
    ...(input.inventoryPool ? { inventoryPool: input.inventoryPool } : {}),
    currencyCode: input.currency.code,
    priceIncrementMinor: input.currency.priceIncrementMinor,
    market: input.market,
    linePricer: createAppLinePricer(db, apps, input.appContext),
    transformer: createCartTransformer(db, apps, input.appContext),
    // A line's purchase option must be one an active app offers.
    purchaseOptions: checkoutPurchaseOptions(apps),
    lineInputs: checkoutLineInputs(apps),
  });
}
