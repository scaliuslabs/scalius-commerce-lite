// The refund dialog of the Payment card, loaded the first time it opens so the
// order page's first render carries no refund form.
import { useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { ChoiceField, Field } from "~/components/ui/field";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { useMessages } from "~/i18n";
import { giftCardOrderMessages } from "~/i18n/gift-card-orders";
import { orderDetailLabel } from "~/i18n/order-detail";
import { orderPaymentDialogMessages } from "~/i18n/order-payment-dialogs";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useRefundOrder } from "~/lib/api-mutations/orders";
import { RefundSettlementField, refundSettlementBody, type RefundSettlement } from "./RefundSettlementField";
import type { Order } from "./types";

const REFUND_REASONS = ["requested_by_customer", "returned_items", "duplicate", "fraudulent", "out_of_stock"] as const;

/** Only what came back is owed; the rest of a refund is the merchant's call. */
export function initialRefundAmount(order: Pick<Order, "refundDue" | "paidAmount">): number | null {
  const owed = Math.min(Number(order.refundDue ?? 0), Number(order.paidAmount ?? 0));
  return owed > 0 ? owed : null;
}

/**
 * Mounted fresh for each opening (the card changes its `key`), so every
 * refund starts from what is owed and carries its own request key: a repeated
 * submit replays the first refund.
 */
export default function RefundDialog({ order, open, onOpenChange, paid, money, locked, hasCashPayment }: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the order has been paid, net of refunds: the most that can go back. */
  paid: number;
  money: (major: number) => string;
  /** A refund is already running at the provider. */
  locked: boolean;
  /** Cash changed hands (cash on delivery): an original-method refund is recorded, not sent. */
  hasCashPayment: boolean;
}) {
  const t = useMessages(orderPaymentDialogMessages);
  const r = useMessages(resourceMessages);
  const g = useMessages(giftCardOrderMessages);
  const owed = initialRefundAmount(order);
  const [amount, setAmount] = useState<number | null>(owed);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [reason, setReason] = useState<string>(owed === null ? "requested_by_customer" : "returned_items");
  const [settlement, setSettlement] = useState<RefundSettlement>("original");
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const requestKey = useRef(crypto.randomUUID());
  const mutation = useRefundOrder();

  // Store credit hands over a gift card, not cash: nothing to confirm.
  const manual = hasCashPayment && settlement === "original";
  const value = amount ?? Number.NaN;
  const valid = Number.isFinite(value) && value > 0 && value <= paid;
  const problem = (): string | null => (valid ? null : t("refund.amountInvalid", { amount: money(paid) }));
  // The confirm button echoes the live amount, e.g. "Record ৳500 cash refund", only while it is valid.
  const confirmLabel = settlement === "store_credit"
    ? valid ? g("refundTo.issueAmount", { amount: money(value) }) : g("refundTo.issue")
    : valid
      ? t(manual ? "refund.recordCashAmount" : "refund.issueAmount", { amount: money(value) })
      : t(manual ? "refund.recordCash" : "refund.issue");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || locked || (manual && !manualConfirmed)) return;
    const found = problem();
    setAmountError(found);
    if (found) {
      document.getElementById("refundAmount")?.focus();
      return;
    }
    mutation.mutate(
      {
        orderId: order.id,
        requestKey: requestKey.current,
        amount: value,
        reason,
        manualSettlementConfirmed: manual ? true : undefined,
        ...refundSettlementBody(settlement),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(manual ? "refund.recordCash" : "refund.issue")}</DialogTitle>
          <DialogDescription>
            {settlement === "store_credit" ? g("refundTo.description") : t(manual ? "refund.manualHelp" : "refund.help")}
          </DialogDescription>
        </DialogHeader>
        <form id="order-refund" method="post" className="space-y-4" onSubmit={submit} noValidate>
          {mutation.isError ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
          <Field
            id="refundAmount"
            label={t("refund.amount")}
            error={amountError ?? undefined}
            help={order.refundDue > 0
              ? t("refund.maxOwed", { owed: money(order.refundDue), amount: money(paid) })
              : t("refund.max", { amount: money(paid) })}
          >
            <MoneyInput
              currencyCode={order.currencyCode ?? ""}
              value={amount}
              disabled={locked}
              onValueChange={(next) => {
                setAmount(next);
                if (amountError) setAmountError(null);
              }}
              onBlur={() => setAmountError(amount === null ? null : problem())}
            />
          </Field>
          <Field id="refundReason" label={t("refund.reason")}>
            <SearchableSelect
              triggerClassName="w-full"
              value={reason}
              onValueChange={setReason}
              options={REFUND_REASONS.map((each) => ({ value: each, label: orderDetailLabel(t, "refund.reason.", each) }))}
            />
          </Field>
          <RefundSettlementField order={order} value={settlement} onChange={setSettlement} disabled={locked} />
          {manual ? (
            <ChoiceField
              id="manualSettlementConfirmed"
              label={t("refund.manualConfirm")}
              control={<Checkbox id="manualSettlementConfirmed" checked={manualConfirmed} onCheckedChange={(checked) => setManualConfirmed(checked === true)} />}
            />
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {r("cancel")}
          </Button>
          <Button type="submit" form="order-refund" loading={mutation.isPending} disabled={locked || (manual && !manualConfirmed)}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
