import type {
  AbandonedCheckoutStageVariant,
  ParsedAbandonedCheckoutDisplay,
} from "@/lib/abandoned-checkout-display";

export type AbandonedStageLabel =
  | "infoCaptured"
  | "addressEntered"
  | "emailEntered"
  | "cartStarted"
  | "sessionCreated"
  | "paymentNotFinished"
  | "unreadable";

/**
 * How far the buyer got, worded from what the row actually shows: "Details
 * entered" only with a name or phone, so it never sits next to "No name · No
 * phone". A preselected city or a note alone isn't details.
 */
export function abandonedStage(
  display: Pick<ParsedAbandonedCheckoutDisplay, "stage" | "variant" | "customerInfo" | "items">,
): { label: AbandonedStageLabel; variant: AbandonedCheckoutStageVariant } {
  if (display.stage !== "infoCaptured") return { label: display.stage, variant: display.variant };
  const info = display.customerInfo;
  if (info.name || info.phone) return { label: "infoCaptured", variant: display.variant };
  if (info.address) return { label: "addressEntered", variant: display.variant };
  if (info.email) return { label: "emailEntered", variant: display.variant };
  return display.items.length > 0
    ? { label: "cartStarted", variant: "secondary" }
    : { label: "sessionCreated", variant: "outline" };
}
