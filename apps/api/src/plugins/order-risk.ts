// `order.risk` (docs/platform/PLUGINS.md): after an order commits, apps that
// implement the point rate its risk. Runs in `waitUntil`, so the buyer never
// waits; the results are advice the merchant sees on the order page (the
// customer card, next to the courier fraud check). Nothing cancels, holds or
// changes the order. Retried runs add nothing (one fact per order and app).

import type { Database } from "@scalius/database/client";
import type { FunctionCart } from "@scalius/shared/plugins";
import { buildAppCartFromOrderPayload, type CheckoutAppFunctions } from "@scalius/core/modules/checkout";
import {
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

export async function runOrderRiskChecks(input: OrderRiskInput): Promise<void> {
  if (!input.apps.points.has("order.risk")) return;
  const { prepared } = input;
  try {
    const [cart, history] = await Promise.all([
      prepared.appCart
        ? Promise.resolve(prepared.appCart)
        : buildAppCartFromOrderPayload(input.db, {
          payload: prepared.commitPayload,
          appDiscounts: prepared.appDiscounts,
          discountCodes: input.discountCodes,
          customerId: input.accountOwnerCustomerId,
          channel: input.channel,
        }),
      readOrderRiskHistory(input.db, {
        orderId: prepared.orderId,
        customerId: input.customerId,
        accountOwnerCustomerId: input.accountOwnerCustomerId,
      }),
    ]);
    const results = await input.apps.run("order.risk", {
      orderId: prepared.orderId,
      cart,
      totalMinor: prepared.commitPayload.orderData.totalAmountMinor,
      paymentMethod: prepared.paymentMethod.slice(0, 64),
      history,
    });
    await recordAppRiskChecks(input.db, prepared.orderId, results.map((result) => ({
      pluginId: result.pluginId,
      appName: result.appName,
      level: result.output.level,
      reasons: result.output.reasons,
    })));
  } catch (error) {
    // Advice only: a failed check never touches the order. No order or buyer facts in the log.
    console.error(`[plugins] order.risk could not be recorded: ${error instanceof Error ? error.name : "error"}`);
  }
}
