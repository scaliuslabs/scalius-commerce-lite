// `order.risk` (docs/platform/PLUGINS.md): after an order commits, apps that
// implement the point rate its risk. Runs in `waitUntil`, so the buyer never
// waits; the results are advice the merchant sees on the order page (the
// customer card, next to the courier fraud check). An answer with
// `hold: true` also puts the order on hold for staff review (orders/holds.ts):
// it is not shipped or moved on until staff release it. Nothing is ever
// cancelled. Retried runs add nothing (one fact and one hold per order and app).
// Every channel runs it the same way: the online store and buyer agents
// (`runOrderRiskChecks`, from the prepared storefront order) and staff
// orders (`runAppOrderRiskChecks`, from the manual order's cart). Callers run
// it only for a commit they made, never for a replay.

import type { Database } from "@scalius/database/client";
import type { FunctionCart } from "@scalius/shared/plugins";
import { buildAppCartFromOrderPayload, type CheckoutAppFunctions } from "@scalius/core/modules/checkout";
import {
  placeAppOrderHolds,
  readOrderRiskHistory,
  recordAppRiskChecks,
  type CreateStorefrontOrderResult,
} from "@scalius/core/modules/orders";

export interface OrderRiskInput {
  db: Database;
  apps: CheckoutAppFunctions;
  prepared: Pick<CreateStorefrontOrderResult, "orderId" | "paymentMethod" | "appCart" | "appDiscounts" | "commitPayload">;
  discountCodes: readonly string[];
  customerId: string | null;
  accountOwnerCustomerId: string | null;
  channel: FunctionCart["channel"];
}

export interface AppOrderRiskInput {
  db: Database;
  apps: CheckoutAppFunctions;
  orderId: string;
  paymentMethod: string;
  totalMinor: number;
  /** The cart apps saw at checkout, or built now (after the commit). */
  cart: () => Promise<FunctionCart>;
  customerId: string | null;
  accountOwnerCustomerId: string | null;
}

export async function runAppOrderRiskChecks(input: AppOrderRiskInput): Promise<void> {
  if (!input.apps.points.has("order.risk")) return;
  try {
    const [cart, history] = await Promise.all([
      input.cart(),
      readOrderRiskHistory(input.db, {
        orderId: input.orderId,
        customerId: input.customerId,
        accountOwnerCustomerId: input.accountOwnerCustomerId,
      }),
    ]);
    const results = await input.apps.run("order.risk", {
      orderId: input.orderId,
      cart,
      totalMinor: input.totalMinor,
      paymentMethod: input.paymentMethod.slice(0, 64),
      history,
    });
    await recordAppRiskChecks(input.db, input.orderId, results.map((result) => ({
      pluginId: result.pluginId,
      appName: result.appName,
      level: result.output.level,
      reasons: result.output.reasons,
    })));
    await placeAppOrderHolds(input.db, input.orderId, results
      .filter((result) => result.output.hold)
      .map((result) => ({ pluginId: result.pluginId, appName: result.appName, reasons: result.output.reasons })));
  } catch (error) {
    // A failed check never touches the order (no hold either). No order or buyer facts in the log.
    console.error(`[plugins] order.risk could not be recorded: ${error instanceof Error ? error.name : "error"}`);
  }
}

export async function runOrderRiskChecks(input: OrderRiskInput): Promise<void> {
  const { prepared } = input;
  await runAppOrderRiskChecks({
    db: input.db,
    apps: input.apps,
    orderId: prepared.orderId,
    paymentMethod: prepared.paymentMethod,
    totalMinor: prepared.commitPayload.orderData.totalAmountMinor,
    cart: () => prepared.appCart
      ? Promise.resolve(prepared.appCart)
      : buildAppCartFromOrderPayload(input.db, {
        payload: prepared.commitPayload,
        appDiscounts: prepared.appDiscounts,
        discountCodes: input.discountCodes,
        customerId: input.accountOwnerCustomerId,
        channel: input.channel,
      }),
    customerId: input.customerId,
    accountOwnerCustomerId: input.accountOwnerCustomerId,
  });
}
