import { useState, type FormEvent } from "react";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { toMinor } from "@scalius/shared/money";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DateInput } from "~/components/ui/date-input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderDisputeMessages } from "~/i18n/order-disputes";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useRecordOrderDispute } from "~/lib/api-mutations/orders";
import type { OrderPaymentsPayload } from "~/lib/api-query-options/orders";
import { formatSavedMinorAmount } from "~/lib/order-money-format";
import { typedMinor } from "~/lib/typed-money";
import { MoneyInput } from "../shared/MoneyInput";

type Payment = OrderPaymentsPayload["payments"][number];

/**
 * A chargeback recorded by hand on a payment whose gateway reports none.
 * Each opening mounts it fresh with its own request key, so a retry after a
 * lost answer records it once.
 */
export function RecordDisputeDialog({
  open,
  onClose,
  orderId,
  payments,
  methodLabel,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  /** The payments a chargeback may be recorded on (at least one). */
  payments: readonly Payment[];
  methodLabel: (method: string) => string;
}) {
  const t = useMessages(orderDisputeMessages);
  const r = useMessages(resourceMessages);
  const mutation = useRecordOrderDispute();
  const [requestKey] = useState(() => `record-dispute-${crypto.randomUUID()}`);
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? "");
  const payment = payments.find((each) => each.id === paymentId) ?? payments[0]!;
  const decimalPlaces = getDecimalPlaces(payment.currency);
  const [amount, setAmount] = useState<number | null>(payment.amount);
  const [reason, setReason] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [withdrawn, setWithdrawn] = useState(true);
  const [lost, setLost] = useState(false);
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const paymentMoney = formatSavedMinorAmount(toMinor(payment.amount, decimalPlaces), { currencyCode: payment.currency, decimalPlaces });

  function check() {
    const found: { amount?: string; reason?: string } = {};
    if (amount === null || !Number.isFinite(amount) || amount <= 0) found.amount = t("amountRequired");
    else if (amount > payment.amount) found.amount = t("amountTooHigh", { amount: paymentMoney });
    if (!reason.trim()) found.reason = t("reasonRequired");
    return found;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = check();
    setErrors(found);
    if (found.amount || found.reason) {
      document.getElementById(found.amount ? "disputeAmount" : "disputeReason")?.focus();
      return;
    }
    mutation.mutate({
      orderId,
      paymentId: payment.id,
      requestKey,
      amountMinor: typedMinor(amount!, payment.currency),
      reason: reason.trim(),
      fundsWithdrawn: withdrawn || lost,
      ...(lost ? { lost: true } : {}),
      ...(dueDate ? { evidenceDueAt: new Date(`${dueDate}T23:59:59`).toISOString() } : {}),
    }, { onSuccess: onClose });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !mutation.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("recordTitle")}</DialogTitle>
          <DialogDescription>{t("recordHelp")}</DialogDescription>
        </DialogHeader>
        <form id="order-record-dispute" method="post" className="space-y-4" onSubmit={submit} noValidate>
          {mutation.isError ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
          {payments.length > 1 ? (
            <Field id="disputePayment" label={t("payment")}>
              <SearchableSelect
                triggerClassName="w-full"
                value={payment.id}
                onValueChange={(value) => {
                  setPaymentId(value);
                  const next = payments.find((each) => each.id === value);
                  if (next) setAmount(next.amount);
                }}
                options={payments.map((each) => ({
                  value: each.id,
                  label: `${methodLabel(each.paymentMethod)} · ${formatSavedMinorAmount(toMinor(each.amount, getDecimalPlaces(each.currency)), { currencyCode: each.currency, decimalPlaces: getDecimalPlaces(each.currency) })}`,
                }))}
              />
            </Field>
          ) : null}
          <Field id="disputeAmount" label={t("amount")} error={errors.amount}>
            <MoneyInput
              currencyCode={payment.currency}
              value={amount}
              onValueChange={(next) => {
                setAmount(next);
                if (errors.amount) setErrors((current) => ({ ...current, amount: undefined }));
              }}
            />
          </Field>
          <Field id="disputeReason" label={t("reasonLabel")} help={t("reasonHelp")} error={errors.reason}>
            <Textarea id="disputeReason" value={reason} maxLength={300} rows={2} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <Field id="disputeDueDate" label={t("dueDate")} optional>
            <DateInput value={dueDate} onValueChange={setDueDate} />
          </Field>
          <div className="flex items-start gap-3">
            <span className="flex h-5 items-center">
              <Checkbox id="dispute-withdrawn" checked={withdrawn || lost} disabled={lost || mutation.isPending} onCheckedChange={(value) => setWithdrawn(value === true)} />
            </span>
            <Label htmlFor="dispute-withdrawn">{t("withdrawn")}</Label>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex h-5 items-center">
              <Checkbox id="dispute-lost" checked={lost} disabled={mutation.isPending} onCheckedChange={(value) => setLost(value === true)} />
            </span>
            <Label htmlFor="dispute-lost">{t("alreadyLost")}</Label>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="submit" form="order-record-dispute" loading={mutation.isPending}>{t("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
