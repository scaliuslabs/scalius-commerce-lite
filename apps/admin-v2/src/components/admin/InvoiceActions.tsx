import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { postApiV1AdminOrdersByIdInvoice } from "@scalius/api-client/sdk";
import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { apiData, type ApiResult } from "~/lib/api";
import { orderErrorMessage } from "~/lib/api-mutations/orders";

export type IssuedInvoiceDocument = ApiResult<typeof postApiV1AdminOrdersByIdInvoice>;

/**
 * Screen-only toolbar above the invoice: back, issue (a draft gets its number
 * once; retries reuse one key) and print. A missing business name is a
 * reminder here, never text inside the document.
 */
export function InvoiceActions({
  orderId,
  issued,
  businessNameMissing,
  expectedOrderVersion,
  onIssued,
}: {
  orderId: string;
  issued: boolean;
  businessNameMissing: boolean;
  expectedOrderVersion: number;
  onIssued: (document: IssuedInvoiceDocument) => void;
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
      setError(orderErrorMessage(issueError));
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
        <div className="flex flex-wrap items-center justify-end gap-2">
          {issued ? null : (
            <Button variant="outline" onClick={() => void issue()} loading={issuing}>{t("invoice.issue")}</Button>
          )}
          <Button onClick={() => window.print()}>{t("invoice.print")}</Button>
        </div>
        {issued ? null : <p className="w-full text-body text-muted-foreground">{t("invoice.issueHelp")}</p>}
        {error ? <p role="alert" className="w-full text-body text-destructive">{error}</p> : null}
        {businessNameMissing ? (
          <Alert variant="warning">
            <p>
              {t("invoice.businessMissing")}{" "}
              <Link to="/admin/settings/store" className="text-link underline">{t("invoice.openSettings")}</Link>
            </p>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
