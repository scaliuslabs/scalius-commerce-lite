import { z } from "zod";
import { fromMinor } from "@scalius/shared/money";

const webUrl = z.string().refine((value) => {
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
});
const parsedMerchantContactSnapshotSchema = z.object({
  phone: z.string().nullable(),
  email: z.string().nullable(),
  whatsappUrl: webUrl.nullable().catch(null),
  socialLinks: z.array(z.object({
    id: z.string(), label: z.string(), url: webUrl,
    iconUrl: webUrl.nullable().catch(null),
  })).catch([]),
});

export const merchantContactSnapshotSchema = z.object({
  phone: z.string().nullable(), email: z.string().nullable(), whatsappUrl: z.string().nullable(),
  socialLinks: z.array(z.object({
    id: z.string(), label: z.string(), url: z.string(), iconUrl: z.string().nullable(),
  })),
});

/** Only the order-time merchant contact fields are returned to a buyer. */
export function presentMerchantContactSnapshot(value: string | null) {
  if (!value) return null;
  try {
    const parsed = parsedMerchantContactSnapshotSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export const buyerPaymentPlanSchema = z.object({
  kind: z.string(), status: z.string(), depositAmount: z.number(), balanceDue: z.number(),
  instructions: z.string().nullable(), contactSnapshot: merchantContactSnapshotSchema.nullable(),
});

export function presentBuyerPaymentPlan(plan: {
  kind: string; status: string; depositAmountMinor: number; balanceDueMinor: number;
  instructions: string | null; contactSnapshot: string | null;
} | null | undefined, decimalPlaces: number) {
  if (!plan) return null;
  return {
    kind: plan.kind, status: plan.status,
    depositAmount: fromMinor(plan.depositAmountMinor, decimalPlaces),
    balanceDue: fromMinor(plan.balanceDueMinor, decimalPlaces),
    instructions: plan.kind === "manual" ? plan.instructions : null,
    contactSnapshot: plan.kind === "manual" ? presentMerchantContactSnapshot(plan.contactSnapshot) : null,
  };
}
