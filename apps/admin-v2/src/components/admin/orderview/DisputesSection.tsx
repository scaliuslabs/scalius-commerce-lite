import { lazy, Suspense, useState } from "react";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useMessages } from "~/i18n";
import { orderDisputeMessages } from "~/i18n/order-disputes";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useResolveOrderDispute } from "~/lib/api-mutations/orders";
import type { OrderDisputesPayload, OrderPaymentsPayload } from "~/lib/api-query-options/orders";
import { formatSavedMinorAmount } from "~/lib/order-money-format";
import { formatOrderDate } from "./formatters";

// The record form loads the first time it opens.
const RecordDisputeDialog = lazy(() => import("./RecordDisputeDialog").then((module) => ({ default: module.RecordDisputeDialog })));

type Dispute = OrderDisputesPayload["disputes"][number];
type Payment = OrderPaymentsPayload["payments"][number];

const minor = (amountMinor: number, currency: string) =>
  formatSavedMinorAmount(amountMinor, { currencyCode: currency, decimalPlaces: getDecimalPlaces(currency) });

function statusVariant(status: Dispute["status"]): "destructive" | "warning" | "secondary" | "success" {
  if (status === "needs_response") return "destructive";
  if (status === "under_review") return "warning";
  return status === "won" ? "success" : "secondary";
}

/**
 * The order's disputes (chargebacks) in its payment card: where each stands,
 * the money the bank holds, the deadline and where to answer it (the
 * provider's own dashboard: evidence is never submitted here). Staff record a
 * chargeback by hand on a payment whose gateway reports none, and decide its
 * outcome.
 */
export function DisputesSection({
  orderId,
  disputes,
  payments,
  handDisputePayments,
  canRecord,
  methodLabel,
}: {
  orderId: string;
  disputes: readonly Dispute[];
  payments: readonly Payment[];
  /** The payments a chargeback may be recorded on by hand, with what each still holds. */
  handDisputePayments: readonly { paymentId: string; heldMinor: number }[];
  canRecord: boolean;
  methodLabel: (method: string) => string;
}) {
  const t = useMessages(orderDisputeMessages);
  const resolve = useResolveOrderDispute();
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordSession, setRecordSession] = useState(0);
  const recordLoaded = useOpenedOnce(recordOpen);
  const [losing, setLosing] = useState<Dispute | null>(null);
  const recordable = canRecord
    ? handDisputePayments.flatMap(({ paymentId, heldMinor }) => {
        const payment = payments.find((each) => each.id === paymentId);
        return payment ? [{ ...payment, heldMinor }] : [];
      })
    : [];
  if (disputes.length === 0 && recordable.length === 0) return null;
  const now = Date.now();

  return (
    <section className="space-y-2" aria-label={t("title")} data-testid="order-disputes">
      {disputes.length > 0 ? (
        <>
          <h3 className="font-medium">{t("title")}</h3>
          <p className="text-muted-foreground">{t("help")}</p>
          <ul className="divide-y">
            {disputes.map((dispute) => {
              const due = dispute.evidenceDueAt ? new Date(dispute.evidenceDueAt) : null;
              const open = dispute.status === "needs_response" || dispute.status === "under_review";
              const resolving = resolve.isPending && resolve.variables?.disputeId === dispute.id;
              return (
                <li key={dispute.id} className="space-y-1 py-2" data-dispute-status={dispute.status}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium">
                      {methodLabel(dispute.gateway)}
                      <Badge variant={statusVariant(dispute.status)}>{t(`status.${dispute.status}`)}</Badge>
                    </span>
                    <span className="tabular-nums">{minor(dispute.amountMinor, dispute.currency)}</span>
                  </div>
                  <p className="text-muted-foreground">
                    {[
                      t(`funds.${dispute.funds}`, { amount: minor(dispute.countedMinor, dispute.currency) }),
                      dispute.status === "needs_response" && due
                        ? due.getTime() < now ? t("pastDue") : t("answerBy", { date: formatOrderDate(due) ?? "" })
                        : null,
                      dispute.byHand ? t("byHand") : null,
                    ].filter(Boolean).join(" · ")}
                  </p>
                  {dispute.reason ? <p className="break-words text-muted-foreground">{t("reason", { reason: dispute.reason })}</p> : null}
                  {dispute.buyerMessage ? <p className="break-words text-muted-foreground">{t("buyerMessage", { message: dispute.buyerMessage })}</p> : null}
                  {dispute.feeMinor && dispute.feeCurrency ? (
                    <p className="text-muted-foreground">{t("fee", { amount: minor(dispute.feeMinor, dispute.feeCurrency) })}</p>
                  ) : null}
                  {dispute.status === "lost" ? <p className="text-muted-foreground">{t("lostHelp")}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    {dispute.dashboardUrl && open ? (
                      <Button asChild variant="outline" size="sm">
                        <a href={dispute.dashboardUrl} target="_blank" rel="noopener noreferrer">{t("answerAt", { provider: methodLabel(dispute.gateway) })}</a>
                      </Button>
                    ) : null}
                    {dispute.byHand && open && canRecord ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={resolve.isPending && !resolving}
                          loading={resolving && resolve.variables?.outcome === "won"}
                          onClick={() => resolve.mutate({ orderId, disputeId: dispute.id, outcome: "won" })}
                        >
                          {t("markWon")}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={resolve.isPending && !resolving}
                          loading={resolving && resolve.variables?.outcome === "lost"}
                          // Lost moves money in the books for good: confirm it, with the amount.
                          onClick={() => setLosing(dispute)}
                        >
                          {t("markLost")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {recordable.length > 0 ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            setRecordSession((session) => session + 1);
            setRecordOpen(true);
          }}
        >
          {t("record")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={losing !== null}
        onOpenChange={(open) => { if (!open) setLosing(null); }}
        title={t("markLostTitle")}
        description={losing ? t("markLostBody", { amount: minor(losing.amountMinor, losing.currency) }) : ""}
        confirmLabel={t("markLost")}
        isLoading={resolve.isPending}
        onConfirm={() => {
          if (!losing) return;
          resolve.mutate({ orderId, disputeId: losing.id, outcome: "lost" }, { onSettled: () => setLosing(null) });
        }}
      />
      {recordLoaded ? (
        <Suspense fallback={null}>
          <RecordDisputeDialog
            key={recordSession}
            open={recordOpen}
            onClose={() => setRecordOpen(false)}
            orderId={orderId}
            payments={recordable}
            methodLabel={methodLabel}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
