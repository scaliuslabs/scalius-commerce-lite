import { useState, type FormEvent } from "react";
import { RECORDED_PAYMENT_VIAS, type RecordedPaymentVia } from "@scalius/shared/payment-terms";
import { toMinor } from "@scalius/shared/money";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderDetailLabel } from "~/i18n/order-detail";
import { orderPaymentDialogMessages } from "~/i18n/order-payment-dialogs";
import { resourceMessages } from "~/i18n/resource";
import { isOrderConflict, orderErrorMessage, useRecordOrderPayment } from "~/lib/api-mutations/orders";
import { MoneyInput } from "../shared/MoneyInput";

/**
 * Money received against an invoice (net terms). Each opening mounts it fresh
 * (the card keys it by session) with its own request key, so a retry after a
 * lost answer records the payment once.
 */
export function RecordPaymentDialog({
  open,
  onClose,
  orderId,
  orderVersion,
  currencyCode,
  decimalPlaces,
  balanceDue,
  money,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  orderVersion: number;
  currencyCode: string;
  decimalPlaces: number;
  /** Major units. */
  balanceDue: number;
  money: (major: number) => string;
}) {
  const t = useMessages(orderPaymentDialogMessages);
  const r = useMessages(resourceMessages);
  const mutation = useRecordOrderPayment();
  const [requestKey] = useState(() => `record-payment-${crypto.randomUUID()}`);
  const [amount, setAmount] = useState<number | null>(balanceDue);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [via, setVia] = useState<RecordedPaymentVia>("bank_transfer");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const problem = (value: number | null): string | null => {
    if (value === null || !Number.isFinite(value) || value <= 0) return t("netTerms.amountRequired");
    if (value > balanceDue) return t("netTerms.amountTooHigh", { amount: money(balanceDue) });
    return null;
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    const issue = problem(amount);
    if (issue) {
      setAmountError(issue);
      document.getElementById("recordPaymentAmount")?.focus();
      return;
    }
    mutation.mutate({
      orderId,
      requestKey,
      amountMinor: toMinor(amount!, decimalPlaces),
      via,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      expectedVersion: orderVersion,
    }, {
      onSuccess: onClose,
      // Changed in another tab: close; the page banner shows the latest.
      onError: (error) => { if (isOrderConflict(error)) onClose(); },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !mutation.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("netTerms.recordTitle")}</DialogTitle>
          <DialogDescription>{t("netTerms.recordHelp")}</DialogDescription>
        </DialogHeader>
        <form id="order-record-payment" method="post" className="space-y-4" onSubmit={submit} noValidate>
          {mutation.isError ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
          <Field
            id="recordPaymentAmount"
            label={t("netTerms.amount")}
            error={amountError ?? undefined}
            help={t("netTerms.amountHelp", { amount: money(balanceDue) })}
          >
            <MoneyInput
              currencyCode={currencyCode}
              value={amount}
              onValueChange={(next) => {
                setAmount(next);
                if (amountError) setAmountError(null);
              }}
              onBlur={() => setAmountError(amount === null ? null : problem(amount))}
            />
          </Field>
          <Field id="recordPaymentVia" label={t("netTerms.via")}>
            <SearchableSelect
              triggerClassName="w-full"
              value={via}
              onValueChange={(value) => setVia(value as RecordedPaymentVia)}
              options={RECORDED_PAYMENT_VIAS.map((each) => ({ value: each, label: orderDetailLabel(t, "netTerms.via.", each) }))}
            />
          </Field>
          <Field id="recordPaymentReference" label={t("netTerms.reference")} help={t("netTerms.referenceHelp")}>
            <Input id="recordPaymentReference" value={reference} maxLength={120} onChange={(event) => setReference(event.target.value)} />
          </Field>
          <Field id="recordPaymentNote" label={t("netTerms.note")}>
            <Textarea id="recordPaymentNote" value={note} maxLength={500} rows={2} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="submit" form="order-record-payment" loading={mutation.isPending}>
            {t("netTerms.save", { amount: money(amount !== null && Number.isFinite(amount) ? amount : 0) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
