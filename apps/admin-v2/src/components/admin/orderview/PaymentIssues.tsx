import type { ReactNode } from "react";
import { useMessages } from "~/i18n";
import { orderPaymentIssueMessages } from "~/i18n/order-payment-issues";
import type { OrderPaymentsPayload } from "~/lib/api-query-options/orders";
import { formatOrderTimestamp } from "./formatters";
import type { OrderTimestamp } from "./types";

type Issue = OrderPaymentsPayload["paymentWebhookIssues"][number];

function time(value: unknown): string | null {
  return formatOrderTimestamp(value as OrderTimestamp | null);
}

/**
 * The payment card's provider updates that did not apply as they came: a
 * refund made outside Scalius, a payment or dispute waiting for something
 * else to finish, and updates that failed. Loads only for an order that has one.
 */
export function PaymentIssues({ issues, methodLabel, refreshButton }: {
  issues: readonly Issue[];
  methodLabel: (method: string) => string;
  refreshButton: ReactNode;
}) {
  const t = useMessages(orderPaymentIssueMessages);
  // A refund the provider reports that the order doesn't record yet is being
  // reconciled, not a failed update: its own words, apart from the failures.
  const externalRefundIssues = issues.filter((issue) => issue.reason === "external_refund");
  // A captured payment waiting for the order's courier booking: recorded on
  // its own once the booking is resolved, so it is not a failure either.
  // A dispute waiting for a refund on the order to settle is waiting too.
  const waitingPaymentIssues = issues.filter((issue) => issue.reason === "shipment_claim" || issue.reason === "refund_in_flight");
  const failedWebhookIssues = issues.filter((issue) => issue.reason !== "external_refund" && issue.reason !== "shipment_claim" && issue.reason !== "refund_in_flight");
  const waitingOnlyForRefund = waitingPaymentIssues.every((issue) => issue.reason === "refund_in_flight");

  return (
    <>
      {externalRefundIssues.length > 0 ? (
        <section role="status" className="space-y-2" data-testid="external-refunds">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium">{t("externalTitle")}</p>
              <p className="text-muted-foreground">{t("externalHelp")}</p>
            </div>
            {refreshButton}
          </div>
          <ul className="divide-y text-muted-foreground">
            {externalRefundIssues.map((issue) => (
              <li key={issue.id} className="py-2">
                <p>{[methodLabel(issue.provider), time(issue.processedAt)].filter(Boolean).join(" · ")}</p>
                <p>{t("reason.external_refund", { gateway: methodLabel(issue.provider) })}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {waitingPaymentIssues.length > 0 ? (
        <section role="status" className="space-y-2" data-testid="payments-waiting-for-shipment">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium">{t(waitingOnlyForRefund ? "refundWaitingTitle" : "waitingTitle")}</p>
              <p className="text-muted-foreground">{t(waitingOnlyForRefund ? "refundWaitingHelp" : "waitingHelp")}</p>
            </div>
            {refreshButton}
          </div>
          <ul className="divide-y text-muted-foreground">
            {waitingPaymentIssues.map((issue) => (
              <li key={issue.id} className="py-2">
                <p>{[methodLabel(issue.provider), time(issue.processedAt)].filter(Boolean).join(" · ")}</p>
                <p>{t(issue.reason === "refund_in_flight" ? "reason.refund_in_flight" : "reason.shipment_claim", { gateway: methodLabel(issue.provider) })}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {failedWebhookIssues.length > 0 ? (
        <section role="status" className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-destructive">{t("title")}</p>
              <p className="text-muted-foreground">{t("help")}</p>
            </div>
            {refreshButton}
          </div>
          <ul className="divide-y text-muted-foreground">
            {failedWebhookIssues.map((issue) => (
              <li key={issue.id} className="py-2">
                <p>{[methodLabel(issue.provider), time(issue.processedAt)].filter(Boolean).join(" · ")}</p>
                <p>{t(`reason.${issue.reason}`, { gateway: methodLabel(issue.provider) })}</p>
                {issue.error ? <p className="break-words">{issue.error}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
