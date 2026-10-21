import { useState } from "react";
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
import { isOrderConflict, orderErrorMessage, useUpdateOrderCod } from "~/lib/api-mutations/orders";
import type { postApiV1AdminOrdersByIdCod } from "@scalius/api-client/sdk";
import type { ApiBody } from "~/lib/api";

export type CodAction = "collected" | "failed" | "returned";
type CodFailureReason = Extract<ApiBody<typeof postApiV1AdminOrdersByIdCod>, { action: "failed" }>["reason"];

const COD_FAILURE_REASONS: CodFailureReason[] = ["not_home", "refused", "no_cash", "wrong_address", "other"];

/**
 * The cash-on-delivery dialogs (collected, failed, returned) of the Payment
 * card. They load the first time one opens; each opening mounts them fresh
 * (the card keys them by session), so no field keeps an earlier entry.
 */
export function CodDialogs({
  orderId,
  action,
  onClose,
  initialCollector,
  hasBalanceDue,
  delivered = false,
  collectTitle,
  cashAmount,
  amountDue,
  sentUnits,
  money,
  canCollect,
  canFail,
  canReturn,
}: {
  orderId: string;
  /** The open dialog, or null while all three are closed. */
  action: CodAction | null;
  onClose: () => void;
  /** Usually the rider who took the parcel collected the cash (R3-ORD-08); still editable. */
  initialCollector: string;
  hasBalanceDue: boolean;
  /** The parcel was already marked delivered: collecting only pays it. */
  delivered?: boolean;
  collectTitle: string;
  cashAmount: number;
  amountDue: number;
  sentUnits: number;
  money: (major: number) => string;
  canCollect: boolean;
  canFail: boolean;
  canReturn: boolean;
}) {
  const t = useMessages(orderPaymentDialogMessages);
  const r = useMessages(resourceMessages);
  const mutation = useUpdateOrderCod();
  const [collectedBy, setCollectedBy] = useState(initialCollector);
  const [collectorError, setCollectorError] = useState<string | null>(null);
  const [failReason, setFailReason] = useState<CodFailureReason>("not_home");
  const [failNotes, setFailNotes] = useState("");

  function submit() {
    if (!action) return;
    let body: { orderId: string } & ApiBody<typeof postApiV1AdminOrdersByIdCod>;
    if (action === "collected") {
      if (!collectedBy.trim()) {
        setCollectorError(t("cod.collectorRequired"));
        document.getElementById("collectedBy")?.focus();
        return;
      }
      body = { orderId, action: "collected", collectedBy: collectedBy.trim(), collectedAmount: cashAmount };
    } else if (action === "failed") {
      body = {
        orderId,
        action: "failed",
        reason: failReason,
        ...(failNotes.trim() ? { notes: failNotes.trim() } : {}),
      };
    } else {
      body = { orderId, action: "returned" };
    }
    // Already recorded in another tab: close; the page banner says by whom and shows the latest.
    mutation.mutate(body, {
      onSuccess: onClose,
      onError: (error) => { if (isOrderConflict(error)) onClose(); },
    });
  }

  const onOpenChange = (open: boolean) => { if (!open && !mutation.isPending) onClose(); };
  const failure = mutation.isError ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null;

  return (
    <>
      <Dialog open={action === "collected"} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{collectTitle}</DialogTitle>
            <DialogDescription>{t(delivered ? "cod.collectHelpDelivered" : hasBalanceDue ? "cod.balanceHelp" : "cod.collectHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {failure}
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-muted-foreground">{t("cod.amountToCollect")}</p>
              <p className="text-heading-md font-semibold tabular-nums">{money(cashAmount)}</p>
            </div>
            <Field id="collectedBy" label={t("cod.collectedBy")} error={collectorError ? collectorError : undefined}>
              <Input
                id="collectedBy"
                placeholder={t("cod.collectorPlaceholder")}
                value={collectedBy}
                required
                maxLength={120}
                aria-invalid={Boolean(collectorError) || undefined}
                aria-describedby={collectorError ? "collectedBy-error" : undefined}
                onChange={(e) => setCollectedBy(e.target.value)}
                onBlur={() => setCollectorError(collectedBy.trim() ? null : t("cod.collectorRequired"))}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>{r("cancel")}</Button>
            <Button onClick={submit} loading={mutation.isPending} disabled={!canCollect}>
              {t("cod.collectAmount", { amount: money(cashAmount) })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={action === "failed"} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cod.recordFailure")}</DialogTitle>
            <DialogDescription>{t("cod.failureHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {failure}
            <Field id="failReason" label={t("cod.failureReason")}>
              <SearchableSelect
                triggerClassName="w-full"
                id="failReason"
                value={failReason}
                onValueChange={(value) => setFailReason(value as CodFailureReason)}
                options={COD_FAILURE_REASONS.map((reason) => ({ value: reason, label: orderDetailLabel(t, "cod.reason.", reason) }))}
              />
            </Field>
            <Field id="failNotes" label={t("cod.notes")}>
              <Textarea id="failNotes" value={failNotes} maxLength={500} onChange={(e) => setFailNotes(e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>{r("cancel")}</Button>
            <Button variant="destructive" onClick={submit} loading={mutation.isPending} disabled={!canFail}>
              {t("cod.recordFailure")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={action === "returned"} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{sentUnits === 1 ? t("cod.returnTitleOne") : t("cod.returnTitle", { count: sentUnits })}</DialogTitle>
            <DialogDescription>
              {[
                amountDue > 0 ? t("cod.returnBalance", { amount: money(amountDue) }) : null,
                t("cod.returnHelp"),
              ].filter(Boolean).join(" ")}
            </DialogDescription>
          </DialogHeader>
          {failure}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>{r("cancel")}</Button>
            <Button variant="destructive" onClick={submit} loading={mutation.isPending} disabled={!canReturn}>
              {t("cod.markReturned")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
