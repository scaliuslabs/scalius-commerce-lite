import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { postApiV1AdminOrdersByIdInvoice } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { apiData, type ApiResult } from "~/lib/api";

export type InvoiceDocument = ApiResult<typeof postApiV1AdminOrdersByIdInvoice>;

/**
 * Screen-only toolbar above the invoice. An issued invoice prints; a draft is
 * issued first, which allocates its number once (retries reuse one key).
 */
export function InvoiceActions({
  orderId,
  issued,
  expectedOrderVersion,
  onIssued,
}: {
  orderId: string;
  issued: boolean;
  expectedOrderVersion: number;
  onIssued: (document: InvoiceDocument) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const operationKey = useRef<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    if (issuing) return;
    operationKey.current ??= `invoice:${crypto.randomUUID()}`;
    setIssuing(true);
    setError(null);
    try {
      const document = await apiData(postApiV1AdminOrdersByIdInvoice({
        path: { id: orderId },
        body: { operationKey: operationKey.current, expectedOrderVersion },
      }));
      operationKey.current = null;
      onIssued(document);
    } catch (issueError) {
      setError(issueError instanceof Error && issueError.message ? issueError.message : t("invoice.issueFailed"));
    } finally {
      setIssuing(false);
    }
  };

  return (
    <div className="sticky top-0 z-10 border-b bg-background print:hidden">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 p-3">
        <Button variant="ghost" asChild>
          <Link to="/admin/orders/$orderId" params={{ orderId }}>{t("invoice.back")}</Link>
        </Button>
        {issued ? (
          <Button onClick={() => window.print()}>{t("invoice.print")}</Button>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="text-body text-muted-foreground">{t("invoice.issueHelp")}</p>
            <Button onClick={() => void issue()} disabled={issuing}>
              {issuing ? t("invoice.issuing") : t("invoice.issue")}
            </Button>
          </div>
        )}
        {error ? <p role="alert" className="w-full text-body text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
