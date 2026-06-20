import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { PaymentPlanStatus, paymentPlans } from "@scalius/database/schema";
import type { PaymentSessionOrder, PaymentSessionPolicy } from "./payment-session-policy";

export async function ensurePendingPaymentPlanForSession(
  db: Database,
  order: Pick<PaymentSessionOrder, "id" | "totalAmount">,
  policy: PaymentSessionPolicy,
): Promise<void> {
  if (policy.paymentType !== "deposit") return;

  await db
    .insert(paymentPlans)
    .values({
      id: crypto.randomUUID(),
      orderId: order.id,
      totalAmount: order.totalAmount,
      depositAmount: policy.depositAmount,
      balanceDue: policy.balanceDue,
      status: PaymentPlanStatus.PENDING,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .onConflictDoNothing();
}
