import { useState, type FormEvent } from "react";
import { RECORDED_PAYMENT_VIAS, type RecordedPaymentVia } from "@scalius/shared/payment-terms";
import { typedMinor } from "~/lib/typed-money";
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
import { readAdminApiError } from "~/lib/admin-api-error";
import { MoneyInput } from "../shared/MoneyInput";
import { CommandKeyNotice } from "~/components/admin/shared/CommandKeyNotice";

/**
 * What a `payment_in_progress` refusal says about the order's other payment:
 * one being set up or charged now (wait), or a payment page the buyer could
 * still pay (wait, or record the whole balance anyway); null for any other error.
 */
function openPaymentOf(error: unknown): "running" | "page" | null {
  const refusal = readAdminApiError(error);
  if (refusal?.code !== "payment_in_progress") return null;
  return (refusal.details as { status?: unknown } | undefined)?.status === "processing" ? "running" : "page";
}

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
  balanceDue,
  money,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  orderVersion: number;
  currencyCode: string;
  /** Major units. */
  balanceDue: number;
  money: (major: number) => string;
}) {
  const t = useMessages(orderPaymentDialogMessages);
  const r = useMessages(resourceMessages);
  const mutation = useRecordOrderPayment();
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

  const openPayment = mutation.isError ? openPaymentOf(mutation.error) : null;

  function send(anyway: boolean) {
    mutation.mutate({
      orderId,
      amountMinor: typedMinor(amount!, currencyCode),
      via,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      expectedRevision: orderVersion,
      ...(anyway ? { allowOpenAttempt: true } : {}),
    }, {
      onSuccess: onClose,
      // Changed in another tab: close; the page banner shows the latest. Another payment open: stay and say so.
      onError: (error) => { if (isOrderConflict(error) && !openPaymentOf(error)) onClose(); },
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const issue = problem(amount);
    if (issue) {
      setAmountError(issue);
      document.getElementById("recordPaymentAmount")?.focus();
      return;
    }
    send(false);
  }

  return (
    <Dialog open={open} onOpenChange={mutation.guardClose((next) => { if (!next) onClose(); })}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("netTerms.recordTitle")}</DialogTitle>
          <DialogDescription>{t("netTerms.recordHelp")}</DialogDescription>
        </DialogHeader>
        <form id="order-record-payment" method="post" className="space-y-4" onSubmit={submit} noValidate>
          <CommandKeyNotice notice={mutation.notice({ orderId })} target="order" startOver={{ kind: "payment", onClick: () => mutation.forget({ orderId }) }} />
          {openPayment === "running" ? <Alert variant="destructive"><AlertDescription>{t("netTerms.paymentRunning")}</AlertDescription></Alert> : null}
          {openPayment === "page" ? (
            <Alert variant="destructive">
              <AlertDescription>
                <div className="flex flex-col items-start gap-2">
                  <p>{t("netTerms.pageOpen", { amount: money(amount ?? 0) })}</p>
                  <p>{t("netTerms.recordAnywayHelp")}</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => send(true)} loading={mutation.isPending}>
                    {t("netTerms.recordAnyway", { amount: money(amount ?? 0) })}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {mutation.isError && !openPayment ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
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
          <Field id="recordPaymentReference" label={t("netTerms.reference")} optional help={t("netTerms.referenceHelp")}>
            <Input id="recordPaymentReference" value={reference} maxLength={120} onChange={(event) => setReference(event.target.value)} />
          </Field>
          <Field id="recordPaymentNote" label={t("netTerms.note")} optional>
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
