// The refund dialog of the Payment card, loaded the first time it opens so the
// order page's first render carries no refund form.
import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { Label } from "~/components/ui/label";
import { NumberInput } from "~/components/ui/number-input";
import { useMessages } from "~/i18n";
import { giftCardOrderMessages } from "~/i18n/gift-card-orders";
import { refundRefusalMessages } from "~/i18n/refund-refusals";
import { orderDetailLabel } from "~/i18n/order-detail";
import { orderPaymentDialogMessages } from "~/i18n/order-payment-dialogs";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useRefundOrder } from "~/lib/api-mutations/orders";
import { readAdminApiError } from "~/lib/admin-api-error";
import { orderReturnsQueryOptions } from "~/lib/api-query-options/orders";
import { RefundSettlementField, refundSettlementBody, type RefundSettlement } from "./RefundSettlementField";
import { clampQuantity, getOrderItemName } from "./order-returns/shared";
import { receivedReturnLineQuantities, refundLinesBody, refundableLines } from "./refund-lines";
import type { Order } from "./types";
import type { OrderPaymentsPayload } from "~/lib/api-query-options/orders";
import { refundSettlementTotals } from "@scalius/shared/refund-sources";
import { toMinor } from "@scalius/shared/money";
import { orderCurrencyCode, typedMinor } from "~/lib/typed-money";

const REFUND_REASONS = ["requested_by_customer", "returned_items", "duplicate", "fraudulent", "out_of_stock"] as const;

/**
 * The API's refusal of a refund larger than the order kept (gift cards it sold
 * were spent, or are still to be issued), from its minor units into the
 * order's major units; null for any other failure.
 */
export function giftCardRefundLimit(error: unknown, decimalPlaces: number): { max: number; spent: number; unissued: number } | null {
  const details = readAdminApiError(error)?.details as Record<string, unknown> | undefined;
  if (details?.reason !== "gift_card_value_spent") return null;
  const major = (minor: unknown) => (Number.isSafeInteger(minor) && (minor as number) > 0 ? (minor as number) / 10 ** decimalPlaces : 0);
  return { max: major(details.maxRefundMinor), spent: major(details.spentMinor), unissued: major(details.unissuedMinor) };
}

/** The API refused because the refund would draw on a payment with an open dispute. */
export function refusedForDispute(error: unknown): boolean {
  return (readAdminApiError(error)?.details as Record<string, unknown> | undefined)?.reason === "payment_disputed";
}

/**
 * Only what came back is owed, with the delivery its items were charged
 * (their shipping profile's share, suggested: the merchant edits it); the
 * rest of a refund is the merchant's call.
 */
export function initialRefundAmount(order: Pick<Order, "refundDue" | "paidAmount" | "returnDeliveryShare">): number | null {
  const items = Number(order.refundDue ?? 0);
  const delivery = items > 0 ? Number(order.returnDeliveryShare ?? 0) : 0;
  const owed = Math.min(Number((items + delivery).toFixed(6)), Number(order.paidAmount ?? 0));
  return owed > 0 ? owed : null;
}

type RefundSource = OrderPaymentsPayload["refundSources"][number];

/**
 * How much of a refund staff pay back by hand (cash on delivery, a recorded
 * bank transfer), in minor units: the split `processRefund()` allocates,
 * previewed from the payments read's ordered sources.
 */
export function manualRefundShareMinor(sources: readonly RefundSource[], amountMinor: number, decimalPlaces: number): number {
  const scale = 10 ** decimalPlaces;
  return refundSettlementTotals(
    sources.map((source) => ({ settlement: source.settlement, refundableMinor: Math.round(source.refundable * scale) })),
    amountMinor,
  ).manual;
}

/**
 * Mounted fresh for each opening (the card changes its `key`), so every
 * refund starts from what is owed and carries its own request key: a repeated
 * submit replays the first refund.
 */
export default function RefundDialog({ order, open, onOpenChange, paid, money, locked, refundSources, refundLimit = null }: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the order has been paid, net of refunds: the most that can go back. */
  paid: number;
  money: (major: number) => string;
  /** A refund is already running at the provider. */
  locked: boolean;
  /** Where an original-method refund draws from, in refund order (the order's payments read). */
  refundSources: readonly RefundSource[];
  /** The most the gift cards this order sold leave refundable (some were spent), from the payments read; null when only `paid` bounds it. */
  refundLimit?: number | null;
}) {
  const t = useMessages(orderPaymentDialogMessages);
  const r = useMessages(resourceMessages);
  const g = useMessages(giftCardOrderMessages);
  const why = useMessages(refundRefusalMessages);
  const owed = initialRefundAmount(order);
  const [amount, setAmount] = useState<number | null>(owed);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [reason, setReason] = useState<string>(owed === null ? "requested_by_customer" : "returned_items");
  const [settlement, setSettlement] = useState<RefundSettlement>("original");
  // A late payment its provider could not refund: staff may decide to pay it back by hand instead.
  const [byHand, setByHand] = useState(false);
  const canReturnByHand = settlement === "original" && refundSources.some((source) => source.returnableByHand);
  const previewSources = byHand && canReturnByHand
    ? refundSources.map((source) => source.returnableByHand ? { ...source, settlement: "manual" as const } : source)
    : refundSources;
  // The manual share (minor units) the merchant confirmed paying back: a changed share asks again.
  const [confirmedManualMinor, setConfirmedManualMinor] = useState<number | null>(null);
  const queryClient = useQueryClient();
  // A refund of what came back starts with the returned lines named (read from the returns card's data).
  const [lineQuantities, setLineQuantities] = useState<Record<string, number>>(() => owed === null
    ? {}
    : receivedReturnLineQuantities(
      order.items,
      queryClient.getQueryData(orderReturnsQueryOptions(order.id).queryKey)?.returns ?? [],
      Number(order.refundedAmount ?? 0),
    ));
  const lineChoices = refundableLines(order.items);
  const requestKey = useRef(crypto.randomUUID());
  const mutation = useRefundOrder();
  // The most the server said this refund can be (gift cards the order sold were spent).
  const decimalPlaces = order.currencyDecimalPlaces ?? 2;
  const refusal = giftCardRefundLimit(mutation.error, decimalPlaces);
  // The true maximum from the start (the payments read, for a refund naming no lines), then what
  // the server said for the lines named: naming gift-card units not issued yet can raise it.
  const namesLines = Object.values(lineQuantities).some((quantity) => quantity > 0);
  const preview = namesLines ? null : refundLimit;
  const limit = refusal ? Math.min(paid, refusal.max) : Math.min(paid, preview ?? paid);
  const boundByGiftCards = !refusal && preview !== null && preview < paid;

  const value = amount ?? Number.NaN;
  const valid = Number.isFinite(value) && value > 0 && value <= limit;
  // What the split is previewed for: the typed amount, else everything refundable (minor units of the order's currency).
  const previewMinor = toMinor(valid ? value : limit, decimalPlaces);
  // Store credit hands over a gift card, not money: nothing to confirm. An
  // original-method refund's cash or transfer share is paid back by hand.
  const previewManualMinor = settlement === "original" ? manualRefundShareMinor(previewSources, previewMinor, decimalPlaces) : 0;
  // Every unit of it goes back by hand: the refund is recorded, not sent.
  const recordOnly = previewManualMinor > 0 && previewManualMinor >= previewMinor;
  // What staff confirm they paid back: the share of the amount entered. No
  // amount, no claim: the dialog never says money went back before one is typed.
  const manualMinor = valid ? previewManualMinor : 0;
  const manual = manualMinor > 0;
  const manualConfirmed = manual && confirmedManualMinor === manualMinor;
  const manualAmount = money(manualMinor / 10 ** decimalPlaces);
  const problem = (): string | null => (valid ? null : t("refund.amountInvalid", { amount: money(limit) }));
  // The confirm button echoes the live amount, e.g. "Record ৳500 cash refund", only while it is valid.
  const confirmLabel = settlement === "store_credit"
    ? valid ? g("refundTo.issueAmount", { amount: money(value) }) : g("refundTo.issue")
    : valid
      ? t(recordOnly ? "refund.recordManualAmount" : "refund.issueAmount", { amount: money(value) })
      : t(recordOnly ? "refund.recordManual" : "refund.issue");

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
        // The amount typed, in the order currency's minor units: the API takes integers only.
        amountMinor: typedMinor(value, orderCurrencyCode(order)),
        reason,
        lines: refundLinesBody(order.items, lineQuantities),
        manualSettlementConfirmed: manual ? true : undefined,
        ...(byHand && canReturnByHand ? { returnLatePaymentByHand: true } : {}),
        ...refundSettlementBody(settlement),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(recordOnly ? "refund.recordManual" : "refund.issue")}</DialogTitle>
          <DialogDescription>
            {settlement === "store_credit"
              ? g("refundTo.description")
              : recordOnly
                ? t("refund.manualHelp")
                : manual
                  ? t("refund.mixedHelp", { manual: manualAmount, other: money((previewMinor - manualMinor) / 10 ** decimalPlaces) })
                  : previewManualMinor > 0
                    ? t("refund.mixedHelpAny")
                    : t("refund.help")}
          </DialogDescription>
        </DialogHeader>
        <form id="order-refund" method="post" className="space-y-4" onSubmit={submit} noValidate>
          {mutation.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {refusal
                  ? [
                    refusal.spent > 0 ? why("giftCardSpent", { spent: money(refusal.spent), max: money(refusal.max) }) : null,
                    refusal.unissued > 0 ? why("giftCardUnissued", { unissued: money(refusal.unissued), max: money(refusal.max) }) : null,
                  ].filter(Boolean).join(" ") || t("refund.max", { amount: money(refusal.max) })
                  : refusedForDispute(mutation.error) ? why("paymentDisputed") : orderErrorMessage(mutation.error)}
              </AlertDescription>
            </Alert>
          ) : null}
          <Field
            id="refundAmount"
            label={t("refund.amount")}
            error={amountError ?? undefined}
            help={order.refundDue > 0
              ? (order.returnDeliveryShare ?? 0) > 0
                ? t("refund.maxOwedDelivery", { owed: money(order.refundDue), delivery: money(order.returnDeliveryShare!), amount: money(limit) })
                : t("refund.maxOwed", { owed: money(order.refundDue), amount: money(limit) })
              : boundByGiftCards
                ? why("giftCardLimit", { max: money(limit) })
                : t("refund.max", { amount: money(limit) })}
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
          {lineChoices.length > 0 ? (
            <div role="group" aria-labelledby="refundLines-label" className="flex min-w-0 flex-col gap-1">
              <Label id="refundLines-label">
                {t("refund.lines")}
                <span className="font-normal text-muted-foreground"> {t("refund.linesOptional")}</span>
              </Label>
              <ul className="divide-y rounded-lg border">
                {lineChoices.map((item) => {
                  const name = getOrderItemName(item);
                  return (
                    <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-body">
                      <div className="min-w-0">
                        <p className="font-medium">{name}</p>
                        <p className="text-muted-foreground">{t("refund.linesOrdered", { count: item.quantity })}</p>
                      </div>
                      <NumberInput
                        id={`refund-line-${item.id}`}
                        integer
                        className="w-20 shrink-0"
                        aria-label={t("refund.linesQty", { name })}
                        disabled={locked}
                        value={lineQuantities[item.id] ?? 0}
                        onValueChange={(value) => {
                          setLineQuantities((current) => ({ ...current, [item.id]: clampQuantity(value, item.quantity) }));
                          // Naming unissued gift-card units changes the most the server allows: ask it again.
                          if (refusal) mutation.reset();
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
              <p className="text-body text-muted-foreground">{t("refund.linesHelp")}</p>
            </div>
          ) : null}
          {order.items.some((item) => item.fulfillmentType === "gift_card") ? (
            <p className="text-body text-muted-foreground">{g("refundTo.boughtCards")}</p>
          ) : null}
          <RefundSettlementField order={order} value={settlement} onChange={setSettlement} disabled={locked} />
          {canReturnByHand ? (
            <ChoiceField
              id="returnLatePaymentByHand"
              label={t("refund.returnByHand")}
              help={t("refund.returnByHandHelp")}
              control={(
                <Checkbox
                  id="returnLatePaymentByHand"
                  checked={byHand}
                  onCheckedChange={(checked) => { setByHand(checked === true); setConfirmedManualMinor(null); }}
                />
              )}
            />
          ) : null}
          {manual ? (
            <ChoiceField
              id="manualSettlementConfirmed"
              label={t("refund.manualConfirm", { amount: manualAmount })}
              control={(
                <Checkbox
                  id="manualSettlementConfirmed"
                  checked={manualConfirmed}
                  onCheckedChange={(checked) => setConfirmedManualMinor(checked === true ? manualMinor : null)}
                />
              )}
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
