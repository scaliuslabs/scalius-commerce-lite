import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { postApiV1AdminOrdersByIdInvoice } from "@scalius/api-client/sdk";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { orderInvoiceMessages as orderDetailMessages } from "~/i18n/order-invoice";
import { apiData, type ApiResult } from "~/lib/api";
import { orderErrorMessage } from "~/lib/api-mutations/orders";
import { useCommand } from "~/lib/use-command";
import { CommandKeyNotice } from "~/components/admin/shared/CommandKeyNotice";

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
  packingSlip = false,
  languageToggle = null,
}: {
  orderId: string;
  issued: boolean;
  businessNameMissing: boolean;
  expectedOrderVersion: number;
  onIssued: (document: IssuedInvoiceDocument) => void;
  /** The packing slip: printed as is, nothing to issue. */
  packingSlip?: boolean;
  /** The link to the other language's copy (`InvoiceCopyToggle`). */
  languageToggle?: ReactNode;
}) {
  const t = useMessages(orderDetailMessages);
  // One operation key per issue until it succeeds: a retry never takes a second invoice number.
  const command = useCommand({
    name: "orders.invoice",
    createKey: () => `invoice:${crypto.randomUUID()}`,
    mutationFn: (input: { orderId: string; expectedOrderVersion: number }, operationKey: string) =>
      apiData(postApiV1AdminOrdersByIdInvoice({ path: { id: input.orderId }, body: { operationKey, expectedOrderVersion: input.expectedOrderVersion } })),
  });
  const issuing = command.isPending;
  const error = command.error ? orderErrorMessage(command.error) : null;
  const issue = () => command.mutate({ orderId, expectedOrderVersion }, { onSuccess: (document) => onIssued(document) });

  return (
    <div className="sticky top-0 z-10 border-b bg-background print:hidden">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 p-3">
        <Button variant="ghost" asChild>
          <Link to="/admin/orders/$orderId" params={{ orderId }}>{t("invoice.back")}</Link>
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {issued || packingSlip ? null : (
            <Button variant="outline" onClick={() => void issue()} loading={issuing}>{t("invoice.issue")}</Button>
          )}
          {languageToggle}
          <Button onClick={() => window.print()}>{t("invoice.print")}</Button>
        </div>
        {issued || packingSlip ? null : <p className="w-full text-body text-muted-foreground">{t("invoice.issueHelp")}</p>}
        <CommandKeyNotice notice={command.notice({ orderId })} target="order" />
        {error ? <p role="alert" className="w-full text-body text-destructive">{error}</p> : null}
        {businessNameMissing ? (
          <Alert variant="warning">
            <AlertDescription>
              {t("invoice.businessMissing")}{" "}
              <Link to="/admin/settings/store" className="text-link underline">{t("invoice.openSettings")}</Link>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
