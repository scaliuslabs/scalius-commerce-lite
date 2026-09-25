// "Refund to: Original payment / Store credit (gift card)" in the refund dialog (Wave B §4.4).
// Store credit issues one new gift card for the refund amount to the order
// contact, so no cash or provider refund is involved (the BD COD case).
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useMessages } from "~/i18n";
import { giftCardOrderMessages } from "~/i18n/gift-card-orders";
import type { Order } from "./types";

export type RefundSettlement = "original" | "store_credit";

const SETTLEMENTS: readonly RefundSettlement[] = ["original", "store_credit"];

/** Where a store-credit card goes: the order's email, else its phone (the API picks the same). */
export function storeCreditContact(order: Pick<Order, "customerEmail" | "customerPhone">): string {
  return order.customerEmail?.trim() || order.customerPhone;
}

export function RefundSettlementField({ order, value, onChange, disabled }: {
  order: Order;
  value: RefundSettlement;
  onChange: (value: RefundSettlement) => void;
  disabled?: boolean;
}) {
  const t = useMessages(giftCardOrderMessages);
  // The contact is data, not copy: split the sentence around it so it can sit in <code>.
  const [before, after] = t("refundTo.storeCreditHelp", { contact: "\u0000" }).split("\u0000");

  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 font-medium">{t("refundTo.label")}</legend>
      <RadioGroup
        value={value}
        disabled={disabled}
        aria-describedby={value === "store_credit" ? "refundSettlement-help" : undefined}
        onValueChange={(next) => {
          if ((SETTLEMENTS as readonly string[]).includes(next)) onChange(next as RefundSettlement);
        }}
      >
        {SETTLEMENTS.map((settlement) => (
          <div key={settlement} className="flex items-start gap-3">
            <span className="flex h-lh items-center">
              <RadioGroupItem id={`refundSettlement-${settlement}`} value={settlement} />
            </span>
            <Label htmlFor={`refundSettlement-${settlement}`}>
              {t(settlement === "original" ? "refundTo.original" : "refundTo.storeCredit")}
            </Label>
          </div>
        ))}
      </RadioGroup>
      {value === "store_credit" ? (
        <p id="refundSettlement-help" className="text-muted-foreground">
          {before}<code>{storeCreditContact(order)}</code>{after}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * The refund request's settlement field. "original" is the API default, so
 * an ordinary refund sends the same body as before store credit existed.
 */
export function refundSettlementBody(settlement: RefundSettlement): { settlement?: "store_credit" } {
  return settlement === "store_credit" ? { settlement } : {};
}
