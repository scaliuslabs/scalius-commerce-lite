import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { PaymentPlanStatus, paymentPlans } from "@scalius/database/schema";
import { ConflictError } from "../../utils/api-error";
import type { PaymentSessionOrder, PaymentSessionPolicy } from "./payment-session-policy";

export async function ensurePendingPaymentPlanForSession(
  db: Database,
  order: Pick<PaymentSessionOrder, "id">,
  policy: PaymentSessionPolicy,
): Promise<void> {
  if (policy.paymentType !== "deposit" || !policy.requiresPlanCreation) return;

  const inserted = await db
    .insert(paymentPlans)
    .values({
      id: crypto.randomUUID(),
      orderId: order.id,
      totalAmountMinor: policy.orderTotalMinor,
      depositAmountMinor: policy.depositAmountMinor,
      balanceDueMinor: policy.balanceDueMinor,
      status: PaymentPlanStatus.PENDING,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoNothing()
    .returning({ id: paymentPlans.id });
  if (inserted.length !== 1) {
    throw new ConflictError(
      "A partial payment plan was created concurrently. Retry so the saved plan can be verified before payment.",
    );
  }
}
